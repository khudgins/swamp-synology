/**
 * Unit tests for the DSM client.
 *
 * Focused on the invariants that protect the operator: credentials must never
 * cross a cleartext connection, schema defaults must be present at runtime even
 * when a definition omits them, and a DSM error code must arrive with an
 * explanation attached rather than as a bare number.
 *
 * @module
 */

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  assertTransportSafe,
  discoverApis,
  type DsmApiEntry,
  DsmError,
  negotiateVersion,
  normalizeTransport,
  num,
  str,
} from "./client.ts";

/** A minimally-specified transport, as a sparse definition would supply it. */
function sparse(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://nas.example.com:5001",
    account: "svc",
    password: "pw",
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

/** Swap in a stub fetch for the duration of `fn`. */
async function withFetch(
  stub: (input: string | URL | Request) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = stub as any;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("normalizeTransport fills defaults a definition omits", () => {
  // Swamp hands methods the definition's own object; schema defaults are NOT
  // materialised. Without this, AbortSignal.timeout(undefined) throws.
  const t = normalizeTransport(sparse());
  assertEquals(t.timeoutMs, 30_000);
  assertEquals(t.sessionName, "FileStation");
  assertEquals(t.skipTlsVerify, false);
  assertEquals(t.allowInsecureHttp, false);
});

Deno.test("normalizeTransport preserves explicit values", () => {
  const t = normalizeTransport(
    sparse({ timeoutMs: 5000, sessionName: "DSM" }),
  );
  assertEquals(t.timeoutMs, 5000);
  assertEquals(t.sessionName, "DSM");
});

Deno.test("the default session name is a real DSM application", () => {
  // DSM permission-checks `session` as an application name and rejects unknown
  // values with error 402 at login. A vanity default breaks every consumer.
  const valid = ["FileStation", "DSM", "DownloadStation", "AudioStation"];
  assertEquals(valid.includes(normalizeTransport(sparse()).sessionName), true);
});

Deno.test("cleartext is refused so the password stays off the wire", () => {
  const err = assertThrows(
    () =>
      assertTransportSafe(normalizeTransport(sparse({
        baseUrl: "http://nas.example.com:5000",
      }))),
    DsmError,
  );
  assertEquals(err.message.includes("refusing to send DSM credentials"), true);
});

Deno.test("cleartext is permitted only when opted into deliberately", () => {
  assertTransportSafe(normalizeTransport(sparse({
    baseUrl: "http://nas.example.com:5000",
    allowInsecureHttp: true,
  })));
});

Deno.test("https is accepted", () => {
  assertTransportSafe(normalizeTransport(sparse()));
});

Deno.test("negotiateVersion stays inside the appliance's advertised range", () => {
  const entry: DsmApiEntry = {
    name: "SYNO.FileStation.List",
    path: "entry.cgi",
    minVersion: 2,
    maxVersion: 3,
  };
  assertEquals(negotiateVersion(entry, 3), 3);
  // Never exceed what the appliance accepts, even if we understand more.
  assertEquals(negotiateVersion(entry, 9), 3);
  // Never fall below its floor either.
  assertEquals(negotiateVersion(entry, 1), 2);
});

Deno.test("num coerces DSM's inconsistent numerics", () => {
  assertEquals(num(42), 42);
  assertEquals(num("42"), 42);
  assertEquals(num(""), null);
  assertEquals(num(undefined), null);
  assertEquals(num("abc"), null);
  assertEquals(num(Number.NaN), null);
});

Deno.test("str normalises optional string fields", () => {
  assertEquals(str("x"), "x");
  assertEquals(str(7), "7");
  assertEquals(str(""), null);
  assertEquals(str(undefined), null);
});

Deno.test("a DSM error code arrives with its explanation attached", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, error: { code: 402 } }), {
          status: 200,
        }),
      ),
    async () => {
      const err = await assertRejects(
        () => discoverApis(normalizeTransport(sparse())),
        DsmError,
      );
      assertEquals(err.code, 402);
      // The bare code is useless; the gloss is what saves the operator.
      assertEquals(err.message.includes("sessionName"), true);
    },
  );
});

Deno.test("a TLS failure is explained, not passed through raw", async () => {
  await withFetch(
    () =>
      Promise.reject(
        new TypeError("invalid peer certificate: UnknownIssuer"),
      ),
    async () => {
      const err = await assertRejects(
        () => discoverApis(normalizeTransport(sparse())),
        DsmError,
      );
      assertEquals(err.message.includes("TLS verification failed"), true);
      assertEquals(err.message.includes("caCert"), true);
    },
  );
});

Deno.test("an empty API catalogue is rejected", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
        }),
      ),
    async () => {
      await assertRejects(
        () => discoverApis(normalizeTransport(sparse())),
        DsmError,
        "empty catalogue",
      );
    },
  );
});

Deno.test("the API catalogue is parsed into addressable entries", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              "SYNO.API.Auth": {
                path: "entry.cgi",
                minVersion: 1,
                maxVersion: 7,
              },
              "SYNO.FileStation.List": { path: "entry.cgi", maxVersion: 2 },
              "SYNO.Bogus": { notAPath: true },
            },
          }),
          { status: 200 },
        ),
      ),
    async () => {
      const catalog = await discoverApis(normalizeTransport(sparse()));
      assertEquals(catalog.size, 2); // the malformed entry is skipped
      assertEquals(catalog.get("SYNO.API.Auth")?.maxVersion, 7);
      // A missing minVersion defaults to 1 rather than undefined.
      assertEquals(catalog.get("SYNO.FileStation.List")?.minVersion, 1);
    },
  );
});
