/**
 * Shared client for the Synology DSM Web API.
 *
 * DSM differs from most appliance APIs in two ways that shape this module:
 *
 *  1. **It is self-describing.** `SYNO.API.Info` returns every API the
 *     appliance supports, with its CGI path and a min/max version range. Paths
 *     and versions move between DSM releases, so this client *discovers* them
 *     at runtime rather than hardcoding. That is the main defence against the
 *     fact that Synology only publishes official docs for FileStation,
 *     DownloadStation, SurveillanceStation and Virtual Machine Manager — the
 *     Core and Storage APIs used here are reverse-engineered from the web UI.
 *
 *  2. **Auth is session-based, not token-based.** You exchange credentials for
 *     an `sid`, pass it on every subsequent call, and should release it. There
 *     is no long-lived API token to put in a vault, so the credentials
 *     themselves travel on every run. That is why {@link assertTransportSafe}
 *     refuses cleartext by default.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Connection and credential settings for one DSM appliance. */
export const DsmTransportSchema = z.object({
  baseUrl: z.string().url().describe(
    "DSM base URL including scheme and port, e.g. https://nas.example.com:5001",
  ),
  account: z.string().min(1).describe("DSM account name"),
  password: z.string().min(1).meta({ sensitive: true }).describe(
    "DSM account password. Marked sensitive: supply it from a vault reference, " +
      "never inline in a definition.",
  ),
  otpCode: z.string().optional().meta({ sensitive: true }).describe(
    "6-digit OTP, when the account has 2-step verification enabled",
  ),
  sessionName: z.string().default("FileStation").describe(
    "DSM session label. This is NOT a free-form string: DSM treats it as an " +
      "application name and permission-checks against it, rejecting names it " +
      "does not recognise with error 402 (permission denied) at login. Use a " +
      "real DSM application — FileStation, DSM, DownloadStation, AudioStation. " +
      "Distinct labels stop concurrent clients evicting each other's sessions.",
  ),
  caCert: z.string().optional().describe(
    "PEM of the CA that signed the DSM certificate. Required for the default " +
      "self-signed certificate, because skipTlsVerify is a no-op in a " +
      "compiled runtime.",
  ),
  caCertPath: z.string().optional().describe(
    "Absolute path to a PEM file holding the issuing CA, as an alternative to " +
      "inlining caCert. Read at call time. Ignored when caCert is set.",
  ),
  skipTlsVerify: z.boolean().default(false).describe(
    "Honoured only by a runtime started with --unsafely-ignore-certificate-errors; " +
      "a no-op otherwise. Prefer caCert.",
  ),
  allowInsecureHttp: z.boolean().default(false).describe(
    "Permit a plain-http baseUrl. Off by default: DSM auth sends the account " +
      "password on every run, so cleartext exposes it to anything on-path.",
  ),
  timeoutMs: z.number().int().positive().default(30_000).describe(
    "Per-request timeout in milliseconds",
  ),
});

/** Validated DSM transport settings. */
export type DsmTransport = z.infer<typeof DsmTransportSchema>;

/**
 * Materialise schema defaults on a transport before use.
 *
 * A model definition only carries the keys its author wrote. Swamp validates
 * `globalArguments` against the schema, but the object handed to a method or
 * check is the definition's own — schema **defaults are not filled in**. So
 * `timeoutMs` and friends arrive `undefined` at runtime even though the
 * inferred type says otherwise, and `AbortSignal.timeout(undefined)` throws.
 *
 * Re-parsing here is cheap and makes every entry point safe regardless of how
 * sparse the definition was.
 *
 * @param transport Transport settings as supplied by the definition.
 * @returns The same settings with every default applied.
 */
export function normalizeTransport(transport: DsmTransport): DsmTransport {
  const parsed = DsmTransportSchema.parse(transport);
  if (parsed.caCert || !parsed.caCertPath) return parsed;
  // Read here rather than at schema time so a definition stays declarative and
  // the failure surfaces as an actionable message instead of a parse error.
  try {
    return { ...parsed, caCert: Deno.readTextFileSync(parsed.caCertPath) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new DsmError(
      `could not read caCertPath ${parsed.caCertPath}: ${why}. Use an absolute ` +
        `path, or inline the PEM in caCert (a vault reference keeps it to one ` +
        `line: caCert: \${{ vault.get('<vault>', '<key>') }}).`,
    );
  }
}

/** One entry from the `SYNO.API.Info` catalogue. */
export interface DsmApiEntry {
  /** Fully-qualified API name, e.g. `SYNO.Core.System`. */
  name: string;
  /** CGI path relative to `/webapi/`, e.g. `entry.cgi`. */
  path: string;
  /** Lowest protocol version this appliance accepts. */
  minVersion: number;
  /** Highest protocol version this appliance accepts. */
  maxVersion: number;
}

/** The discovered API surface of one appliance, keyed by API name. */
export type DsmApiCatalog = Map<string, DsmApiEntry>;

/**
 * A DSM API failure, carrying the numeric code DSM returned.
 *
 * DSM always answers HTTP 200 and signals failure in the body, so a non-null
 * {@link code} is the only reliable failure signal.
 */
export class DsmError extends Error {
  /** DSM's numeric error code, when the failure came from the API itself. */
  readonly code: number | null;

  /**
   * @param message Human-readable summary, already including any known gloss.
   * @param code DSM numeric error code, or null for transport-level failures.
   */
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "DsmError";
    this.code = code;
  }
}

/**
 * Glosses for the DSM error codes worth explaining.
 *
 * Synology documents these only for FileStation, but the common range (100-107)
 * and the auth range (400-407) are returned across the whole API surface.
 */
const ERROR_GLOSS: Record<number, string> = {
  100: "unknown error",
  101: "invalid parameter",
  102: "the requested API does not exist on this appliance",
  103: "the requested method does not exist",
  104: "the requested API version is not supported by this appliance",
  105:
    "insufficient user privilege — this API likely requires an admin account",
  106: "session timeout",
  107:
    "session interrupted by a duplicate login (another client used the same session name)",
  119: "invalid session id",
  400: "no such account, or incorrect password",
  401: "account disabled",
  402:
    "permission denied — if this happened at login, the account authenticated " +
    "but was refused. The usual cause is a sessionName DSM does not recognise: " +
    "it treats that value as an application name and rejects unknown ones. Use " +
    "FileStation, DSM, DownloadStation or AudioStation. Otherwise, check the " +
    "account's Application permissions in Control Panel > User & Group.",
  403: "2-step verification code required — set otpCode",
  404: "failed to authenticate the 2-step verification code",
  406: "enforce 2-step verification is enabled for this account",
  407: "blocked IP source",
};

/**
 * Reject a transport that would put credentials on the wire in cleartext.
 *
 * @param transport The transport to validate.
 * @throws {DsmError} When the URL is http and `allowInsecureHttp` is not set.
 */
export function assertTransportSafe(transport: DsmTransport): void {
  const url = new URL(transport.baseUrl);
  if (url.protocol === "https:") return;
  if (transport.allowInsecureHttp) return;
  throw new DsmError(
    `refusing to send DSM credentials over ${url.protocol}// — DSM session ` +
      `auth transmits the account password on every run. Use https (DSM's ` +
      `default TLS port is 5001) and set caCert for the self-signed ` +
      `certificate, or set allowInsecureHttp: true to override deliberately.`,
  );
}

/**
 * Build the per-request fetch init, including a disposable TLS client.
 *
 * The custom client is created per request and closed by the caller, so a
 * long-running discovery loop cannot leak file descriptors.
 *
 * @param transport Transport settings supplying TLS material and timeout.
 * @param signal Optional caller cancellation signal.
 * @returns The `RequestInit` plus the client to close when the request settles.
 */
function buildRequestInit(
  transport: DsmTransport,
  signal?: AbortSignal,
): { init: RequestInit; client?: { close?: () => void } } {
  const init: RequestInit = {
    signal: signal ?? AbortSignal.timeout(transport.timeoutMs),
    headers: { "Accept": "application/json" },
  };

  let client: { close?: () => void } | undefined;
  if (transport.caCert || transport.skipTlsVerify) {
    const opts: Record<string, unknown> = {};
    if (transport.caCert) opts.caCerts = [transport.caCert];
    if (transport.skipTlsVerify) opts.unsafelyIgnoreCertificateErrors = true;
    // deno-lint-ignore no-explicit-any
    client = (Deno as any).createHttpClient?.(opts);
    if (client) (init as RequestInit & { client?: unknown }).client = client;
  }
  return { init, client };
}

/**
 * Turn a transport-level failure into an actionable {@link DsmError}.
 *
 * A bare `invalid peer certificate: UnknownIssuer` tells a user nothing about
 * what to do next, and DSM's factory certificate makes that the single most
 * likely first failure. Rethrows non-transport errors untouched.
 *
 * @param err The thrown error.
 * @param transport Normalised transport, for the URL in the message.
 * @returns A {@link DsmError} carrying remediation guidance.
 */
function explainTransportError(
  err: unknown,
  transport: DsmTransport,
): DsmError {
  if (err instanceof DsmError) return err;
  const msg = err instanceof Error ? err.message : String(err);

  if (/certificate|UnknownIssuer|NotValidFor|CaUsed/i.test(msg)) {
    return new DsmError(
      `TLS verification failed for ${transport.baseUrl} (${msg}). DSM ships a ` +
        `self-signed certificate issued by a per-device "Synology Inc. CA": set ` +
        `caCert to that CA's PEM, exported from Control Panel > Security > ` +
        `Certificate > Export (chain.pem in the bundle). Note the factory ` +
        `certificate's SAN is the BARE hostname, so connecting by FQDN still ` +
        `fails hostname verification once the CA is trusted — either connect by ` +
        `the short name or install a certificate matching the name you use. ` +
        `skipTlsVerify is a no-op unless the runtime was started with ` +
        `--unsafely-ignore-certificate-errors.`,
    );
  }
  if (/timed out|timeout|deadline/i.test(msg)) {
    return new DsmError(
      `timed out reaching ${transport.baseUrl} after ${transport.timeoutMs}ms ` +
        `(${msg}). Check the host resolves and DSM's TLS port is open.`,
    );
  }
  if (/dns|resolve|Name or service not known|failed to lookup/i.test(msg)) {
    return new DsmError(
      `could not resolve the host in ${transport.baseUrl} (${msg}).`,
    );
  }
  return new DsmError(`failed to reach ${transport.baseUrl}: ${msg}`);
}

/**
 * Unwrap a DSM envelope, converting `success: false` into a {@link DsmError}.
 *
 * @param body Parsed JSON response body.
 * @param what Short description of the call, used in the error message.
 * @returns The `data` payload, or an empty object when DSM returned none.
 */
function unwrap(body: unknown, what: string): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new DsmError(`${what}: response was not a JSON object`);
  }
  const env = body as {
    success?: boolean;
    data?: unknown;
    error?: { code?: number };
  };
  if (env.success === false) {
    const code = typeof env.error?.code === "number" ? env.error.code : null;
    const gloss = code !== null && ERROR_GLOSS[code]
      ? ` — ${ERROR_GLOSS[code]}`
      : "";
    throw new DsmError(
      `${what} failed (DSM code ${code ?? "unknown"})${gloss}`,
      code,
    );
  }
  return (env.data ?? {}) as Record<string, unknown>;
}

/**
 * Fetch the appliance's API catalogue.
 *
 * This is the only call with a fixed path — `query.cgi` is stable across DSM
 * releases and is what every other path is resolved through.
 *
 * @param transport Connection settings.
 * @param signal Optional cancellation signal.
 * @returns Every API this appliance exposes, keyed by API name.
 */
export async function discoverApis(
  rawTransport: DsmTransport,
  signal?: AbortSignal,
): Promise<DsmApiCatalog> {
  const transport = normalizeTransport(rawTransport);
  assertTransportSafe(transport);
  const url = new URL(
    `${transport.baseUrl.replace(/\/+$/, "")}/webapi/query.cgi`,
  );
  url.searchParams.set("api", "SYNO.API.Info");
  url.searchParams.set("version", "1");
  url.searchParams.set("method", "query");
  url.searchParams.set("query", "all");

  const { init, client } = buildRequestInit(transport, signal);
  try {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw explainTransportError(err, transport);
    }
    if (!res.ok) {
      throw new DsmError(
        `API discovery failed (HTTP ${res.status}) — is ${transport.baseUrl} a DSM appliance?`,
      );
    }
    const data = unwrap(await res.json().catch(() => null), "API discovery");
    const catalog: DsmApiCatalog = new Map();
    for (const [name, raw] of Object.entries(data)) {
      const e = raw as {
        path?: string;
        minVersion?: number;
        maxVersion?: number;
      };
      if (typeof e?.path !== "string") continue;
      catalog.set(name, {
        name,
        path: e.path,
        minVersion: typeof e.minVersion === "number" ? e.minVersion : 1,
        maxVersion: typeof e.maxVersion === "number" ? e.maxVersion : 1,
      });
    }
    if (catalog.size === 0) {
      throw new DsmError("API discovery returned an empty catalogue");
    }
    return catalog;
  } finally {
    client?.close?.();
  }
}

/**
 * Choose the protocol version to call an API with.
 *
 * Picks the highest version this client is known to handle that the appliance
 * also accepts, so a newer DSM does not silently change response shape.
 *
 * @param entry The catalogue entry for the API.
 * @param preferred The highest version this client understands.
 * @returns A version within the appliance's supported range.
 */
export function negotiateVersion(
  entry: DsmApiEntry,
  preferred: number,
): number {
  if (preferred > entry.maxVersion) return entry.maxVersion;
  if (preferred < entry.minVersion) return entry.minVersion;
  return preferred;
}

/**
 * Look up an API in the catalogue, failing with an actionable message.
 *
 * @param catalog The discovered catalogue.
 * @param name Fully-qualified API name.
 * @returns The catalogue entry.
 * @throws {DsmError} When the appliance does not expose that API.
 */
export function requireApi(catalog: DsmApiCatalog, name: string): DsmApiEntry {
  const entry = catalog.get(name);
  if (!entry) {
    throw new DsmError(
      `this appliance does not expose ${name}. It may need a package ` +
        `installed, a newer DSM, or an admin account to be visible.`,
    );
  }
  return entry;
}

/** An authenticated DSM session. */
export interface DsmSession {
  /** Session id to pass as `_sid` on subsequent calls. */
  sid: string;
  /** The catalogue discovered while establishing the session. */
  catalog: DsmApiCatalog;
}

/**
 * Exchange credentials for a session id.
 *
 * Credentials are sent as a form-encoded POST body rather than query
 * parameters, so they do not land in proxy or webserver access logs.
 *
 * @param transport Connection and credential settings.
 * @param catalog A catalogue from {@link discoverApis}.
 * @param signal Optional cancellation signal.
 * @returns The established session.
 */
export async function login(
  rawTransport: DsmTransport,
  catalog: DsmApiCatalog,
  signal?: AbortSignal,
): Promise<DsmSession> {
  const transport = normalizeTransport(rawTransport);
  assertTransportSafe(transport);
  const entry = requireApi(catalog, "SYNO.API.Auth");
  const version = negotiateVersion(entry, 6);
  const url = `${transport.baseUrl.replace(/\/+$/, "")}/webapi/${entry.path}`;

  const form = new URLSearchParams({
    api: "SYNO.API.Auth",
    version: String(version),
    method: "login",
    account: transport.account,
    passwd: transport.password,
    session: transport.sessionName,
    format: "sid",
  });
  if (transport.otpCode) form.set("otp_code", transport.otpCode);

  const { init, client } = buildRequestInit(transport, signal);
  try {
    const res = await fetch(url, {
      ...init,
      method: "POST",
      headers: {
        ...(init.headers as Record<string, string>),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) throw new DsmError(`DSM login failed (HTTP ${res.status})`);
    const data = unwrap(await res.json().catch(() => null), "DSM login");
    const sid = data.sid;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new DsmError("DSM login succeeded but returned no session id");
    }
    return { sid, catalog };
  } finally {
    client?.close?.();
  }
}

/**
 * Release a session id.
 *
 * Failures are swallowed: a leaked session expires on its own, and letting a
 * logout error mask the real error from the method body would be worse.
 *
 * @param transport Connection settings.
 * @param session The session to release.
 * @param signal Optional cancellation signal.
 */
export async function logout(
  rawTransport: DsmTransport,
  session: DsmSession,
  signal?: AbortSignal,
): Promise<void> {
  const transport = normalizeTransport(rawTransport);
  const entry = session.catalog.get("SYNO.API.Auth");
  if (!entry) return;
  const url = new URL(
    `${transport.baseUrl.replace(/\/+$/, "")}/webapi/${entry.path}`,
  );
  url.searchParams.set("api", "SYNO.API.Auth");
  url.searchParams.set("version", String(negotiateVersion(entry, 6)));
  url.searchParams.set("method", "logout");
  url.searchParams.set("session", transport.sessionName);
  url.searchParams.set("_sid", session.sid);

  const { init, client } = buildRequestInit(transport, signal);
  try {
    await fetch(url, init);
  } catch {
    // Intentionally ignored — see doc comment.
  } finally {
    client?.close?.();
  }
}

/** A single DSM API call. */
export interface DsmCall {
  /** Fully-qualified API name, e.g. `SYNO.Core.System`. */
  api: string;
  /** Method name on that API, e.g. `info`. */
  method: string;
  /** Highest protocol version this client understands for the call. */
  preferredVersion: number;
  /** Extra query parameters. */
  params?: Record<string, string>;
}

/**
 * Perform an authenticated DSM API call.
 *
 * @param transport Connection settings.
 * @param session An established session.
 * @param call The API, method, version and parameters to invoke.
 * @param signal Optional cancellation signal.
 * @returns The unwrapped `data` payload.
 */
export async function request(
  rawTransport: DsmTransport,
  session: DsmSession,
  call: DsmCall,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const transport = normalizeTransport(rawTransport);
  const entry = requireApi(session.catalog, call.api);
  const url = new URL(
    `${transport.baseUrl.replace(/\/+$/, "")}/webapi/${entry.path}`,
  );
  url.searchParams.set("api", call.api);
  url.searchParams.set(
    "version",
    String(negotiateVersion(entry, call.preferredVersion)),
  );
  url.searchParams.set("method", call.method);
  for (const [k, v] of Object.entries(call.params ?? {})) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("_sid", session.sid);

  const { init, client } = buildRequestInit(transport, signal);
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new DsmError(
        `${call.api}.${call.method} failed (HTTP ${res.status})`,
      );
    }
    return unwrap(
      await res.json().catch(() => null),
      `${call.api}.${call.method}`,
    );
  } finally {
    client?.close?.();
  }
}

/**
 * Run a function against a freshly established session, always logging out.
 *
 * @param transport Connection and credential settings.
 * @param fn Receives the session; its return value is passed through.
 * @param signal Optional cancellation signal.
 * @returns Whatever `fn` returned.
 */
export async function withSession<T>(
  rawTransport: DsmTransport,
  fn: (session: DsmSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const transport = normalizeTransport(rawTransport);
  const catalog = await discoverApis(transport, signal);
  const session = await login(transport, catalog, signal);
  try {
    return await fn(session);
  } finally {
    await logout(transport, session, signal);
  }
}

/**
 * Pre-flight check shared by every model type in this extension.
 *
 * Proves the whole path in one go: TLS to the appliance, API discovery, a real
 * login, and a clean logout. Labelled `live` so it can be skipped offline with
 * `--skip-check-label live`.
 *
 * Note the ordering — TLS is established before credentials are sent, so a
 * failure to validate the certificate aborts *before* the password leaves this
 * machine.
 */
export const transportReachableCheck = {
  description:
    "Establish TLS, discover the DSM API catalogue, complete a login, then release the session",
  labels: ["live"],
  execute: async (
    context: {
      globalArgs: { transport: DsmTransport };
      logger: { info: (m: string, p?: unknown) => void };
    },
  ): Promise<{ pass: boolean; errors?: string[] }> => {
    const transport = context.globalArgs.transport;
    try {
      const catalog = await discoverApis(transport);
      const session = await login(transport, catalog);
      await logout(transport, session);
      context.logger.info("DSM reachable: {count} APIs advertised", {
        count: catalog.size,
      });
      return { pass: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { pass: false, errors: [message] };
    }
  },
};

/**
 * Coerce a DSM numeric-ish field to a number.
 *
 * DSM is inconsistent about returning numbers as JSON numbers or as strings,
 * even within one response.
 *
 * @param value The raw field value.
 * @returns The number, or null when it cannot be read as one.
 */
export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Coerce a DSM field to a non-empty string.
 *
 * @param value The raw field value.
 * @returns The string, or null when absent or empty.
 */
export function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}
