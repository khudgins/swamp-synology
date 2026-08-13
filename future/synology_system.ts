/**
 * `@khudgins/synology/system` — read-only system inventory for a Synology DSM
 * appliance.
 *
 * **NOT SHIPPED IN v1.** Held outside `extensions/models/` so it does not load.
 * It requires an admin DSM account, which means it has never been exercised
 * against a real appliance — unlike the storage type. Publishing a type that
 * has never made a successful API call would be the weakest part of an
 * otherwise verified extension. Finish and verify it before adding it back to
 * the manifest.
 *
 * `discover` records two things:
 *
 *  - **`apiCatalog`** — every API this appliance exposes, with its CGI path and
 *    supported version range, straight from `SYNO.API.Info`. This is the map
 *    you consult before writing anything else against a DSM, because the
 *    surface varies by model, DSM release, and installed packages.
 *  - **`system`** — normalised identity and health for the appliance, plus the
 *    untouched DSM payload under `raw`.
 *
 * **Why `raw` exists.** Synology publishes official API documentation only for
 * FileStation, DownloadStation, SurveillanceStation and Virtual Machine
 * Manager. `SYNO.Core.System` is not among them — its field names are
 * reverse-engineered and have moved between DSM releases. Contracts should be
 * written against the normalised fields, which this model keeps stable; `raw`
 * preserves everything so nothing is lost when DSM returns a field this
 * version does not yet map.
 *
 * Read-only by construction: no method here mutates the appliance.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  type DsmApiEntry,
  DsmError,
  DsmTransportSchema,
  num,
  request,
  str,
  transportReachableCheck,
  withSession,
} from "../_lib/dsm/client.ts";

/** Global arguments for a DSM system model instance. */
const GlobalArgsSchema = z.object({
  name: z.string().min(1).default("dsm").describe(
    "Instance label, used in log lines",
  ),
  transport: DsmTransportSchema.describe(
    "How to reach and authenticate to DSM",
  ),
});

/** Validated global arguments. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Normalised appliance identity and health. */
const SystemSchema = z.object({
  model: z.string().nullable().describe("Appliance model, e.g. DS923+"),
  dsmVersion: z.string().nullable().describe("DSM firmware version string"),
  serial: z.string().nullable().describe("Appliance serial number"),
  uptimeSec: z.number().nullable().describe(
    "Uptime in seconds when DSM reported it numerically, else null",
  ),
  uptimeRaw: z.string().nullable().describe(
    "Uptime exactly as DSM reported it",
  ),
  temperatureC: z.number().nullable().describe("System temperature in Celsius"),
  temperatureWarning: z.boolean().nullable().describe(
    "True when DSM flags the current temperature as too high",
  ),
  cpuSeries: z.string().nullable().describe("CPU model string"),
  cpuCores: z.number().nullable().describe("Physical CPU core count"),
  ramMB: z.number().nullable().describe("Installed memory in megabytes"),
  ntpEnabled: z.boolean().nullable().describe("Whether NTP sync is enabled"),
  raw: z.record(z.string(), z.unknown()).describe(
    "The unmodified SYNO.Core.System payload",
  ),
  recordedAt: z.string().describe("ISO-8601 timestamp of this observation"),
});

/** The appliance's advertised API surface. */
const ApiCatalogSchema = z.object({
  apiCount: z.number().describe("Number of APIs the appliance advertises"),
  hasCoreSystem: z.boolean().describe("Whether SYNO.Core.System is exposed"),
  hasStorage: z.boolean().describe(
    "Whether the storage API used by the storage model is exposed",
  ),
  apis: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      minVersion: z.number(),
      maxVersion: z.number(),
    }),
  ).describe("Every advertised API, sorted by name"),
  recordedAt: z.string().describe("ISO-8601 timestamp of this observation"),
});

/** Storage API name, checked for presence so the next model knows it can run. */
const STORAGE_API = "SYNO.Storage.CGI.Storage";

/**
 * Shape the discovered catalogue into its resource payload.
 *
 * @param entries Catalogue entries from the appliance.
 * @param recordedAt ISO timestamp for the observation.
 * @returns The `apiCatalog` resource body.
 */
function buildCatalogResource(
  entries: DsmApiEntry[],
  recordedAt: string,
): z.infer<typeof ApiCatalogSchema> {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return {
    apiCount: sorted.length,
    hasCoreSystem: sorted.some((e) => e.name === "SYNO.Core.System"),
    hasStorage: sorted.some((e) => e.name === STORAGE_API),
    apis: sorted.map((e) => ({
      name: e.name,
      path: e.path,
      minVersion: e.minVersion,
      maxVersion: e.maxVersion,
    })),
    recordedAt,
  };
}

/**
 * Normalise a `SYNO.Core.System` payload into the stable resource shape.
 *
 * Every field is best-effort: DSM omits and renames keys across releases, so a
 * missing value becomes null rather than a failure.
 *
 * @param info The raw DSM payload.
 * @param recordedAt ISO timestamp for the observation.
 * @returns The `system` resource body.
 */
function buildSystemResource(
  info: Record<string, unknown>,
  recordedAt: string,
): z.infer<typeof SystemSchema> {
  const upTime = info.up_time;
  const uptimeSec = num(upTime);
  const tempWarn = info.temperature_warn;
  const ntp = info.ntp_enabled ?? info.enable_ntp;

  return {
    model: str(info.model),
    dsmVersion: str(info.firmware_ver) ?? str(info.version_string) ??
      str(info.firmware_version),
    serial: str(info.serial),
    uptimeSec,
    uptimeRaw: typeof upTime === "string"
      ? upTime
      : uptimeSec !== null
      ? String(uptimeSec)
      : null,
    temperatureC: num(info.sys_temp) ?? num(info.temperature),
    temperatureWarning: typeof tempWarn === "boolean"
      ? tempWarn
      : tempWarn === undefined
      ? null
      : num(tempWarn) === 1,
    cpuSeries: str(info.cpu_series) ?? str(info.cpu_family),
    cpuCores: num(info.cpu_cores),
    ramMB: num(info.ram_size),
    ntpEnabled: typeof ntp === "boolean"
      ? ntp
      : ntp === undefined
      ? null
      : num(ntp) === 1,
    raw: info,
    recordedAt,
  };
}

/** Read-only DSM system model. */
export const model = {
  type: "@khudgins/synology/system",
  version: "2026.08.12.1",
  description:
    "Read-only Synology DSM system inventory: the appliance's advertised API " +
    "catalogue plus normalised identity, uptime and thermal state.",
  globalArguments: GlobalArgsSchema,

  resources: {
    system: {
      description:
        "Normalised appliance identity and health, plus the raw DSM payload",
      schema: SystemSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    apiCatalog: {
      description: "Every API this appliance advertises, with version ranges",
      schema: ApiCatalogSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  checks: {
    "transport-reachable": transportReachableCheck,
  },

  methods: {
    discover: {
      description:
        "Record the appliance's API catalogue and its system identity/health. " +
        "Requires an account permitted to read SYNO.Core.System.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger: {
            info: (m: string, p?: unknown) => void;
            warning: (m: string, p?: unknown) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const transport = context.globalArgs.transport;

        return await withSession(transport, async (session) => {
          const recordedAt = new Date().toISOString();
          const handles: Array<{ name: string }> = [];

          // The catalogue is written first and independently of the system
          // call. It is valid on its own, and when the system call fails for
          // want of privilege it is exactly the artifact needed to diagnose
          // that — so it is worth persisting even if this method then throws.
          const catalogBody = buildCatalogResource(
            [...session.catalog.values()],
            recordedAt,
          );
          handles.push(
            await context.writeResource("apiCatalog", "catalog", catalogBody),
          );
          context.logger.info(
            "{name}: {count} APIs advertised (Core.System={core}, Storage={storage})",
            {
              name: context.globalArgs.name,
              count: catalogBody.apiCount,
              core: catalogBody.hasCoreSystem,
              storage: catalogBody.hasStorage,
            },
          );

          if (!catalogBody.hasCoreSystem) {
            throw new DsmError(
              "this appliance does not advertise SYNO.Core.System — the API " +
                "catalogue was still recorded; inspect it to see what this " +
                "account can reach (a non-admin account commonly sees a " +
                "reduced surface)",
            );
          }

          const info = await request(
            transport,
            session,
            { api: "SYNO.Core.System", method: "info", preferredVersion: 1 },
            context.signal,
          );

          // Surface the observed keys once, so a DSM release that renames a
          // field is visible in the run log rather than silently becoming null.
          context.logger.info("SYNO.Core.System returned keys: {keys}", {
            keys: Object.keys(info).sort().join(", "),
          });

          const systemBody = buildSystemResource(info, recordedAt);
          if (systemBody.model === null && systemBody.serial === null) {
            context.logger.warning(
              "neither model nor serial could be read from SYNO.Core.System — " +
                "field names may have changed; the full payload is preserved under `raw`",
            );
          }
          handles.push(
            await context.writeResource("system", "current", systemBody),
          );

          return { dataHandles: handles };
        }, context.signal);
      },
    },
  },
};
