/**
 * `@khudgins/synology/storage` — read-only shared-folder and volume capacity
 * for a Synology DSM appliance, **without requiring an admin account**.
 *
 * ## Why FileStation rather than the storage API
 *
 * The obvious call for capacity is `SYNO.Storage.CGI.Storage`, and on DSM 7.2+
 * it requires an administrator. Handing a monitoring integration DSM admin to
 * read a percentage is a poor trade.
 *
 * `SYNO.FileStation.List` with `method=list_share` and
 * `additional=["real_path","size","volume_status"]` returns each shared folder
 * the account can see; `volume_status` carries `totalspace`/`freespace` for the
 * volume backing that share, and `real_path` is what makes the volume
 * identifiable at all — `path` is the SHARE path (`/Videos`) and names no
 * volume. This works with an ordinary account limited to the shares you care
 * about, so the model runs at least privilege by construction.
 *
 * Capacity belongs to the volume, so shares are collapsed onto their backing
 * volume and emitted as `volume` resources too. Assert against those: eight
 * shares on one volume are one capacity condition, not eight.
 *
 * The limits are worth stating. A volume with no share this account can see is
 * invisible, and disks, pools and SMART state are unreachable without admin.
 *
 * Read-only by construction: no method here mutates the appliance.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  DsmError,
  DsmTransportSchema,
  num,
  request,
  str,
  transportReachableCheck,
  withSession,
} from "./_lib/dsm/client.ts";

/** Global arguments for a DSM storage model instance. */
const GlobalArgsSchema = z.object({
  name: z.string().min(1).default("dsm-storage").describe(
    "Instance label, used in log lines",
  ),
  transport: DsmTransportSchema.describe(
    "How to reach and authenticate to DSM",
  ),
});

/** Validated global arguments. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One shared folder and the capacity of the volume backing it. */
const ShareSchema = z.object({
  name: z.string().describe("Shared folder name"),
  path: z.string().describe(
    "Share path as DSM reports it — the SHARE path, e.g. /Videos, which " +
      "carries no volume information",
  ),
  realPath: z.string().nullable().describe(
    "Filesystem path behind the share, e.g. /volume1/Videos",
  ),
  volume: z.string().nullable().describe(
    "Backing volume derived from realPath, e.g. /volume1",
  ),
  totalBytes: z.number().nullable().describe("Capacity of the backing volume"),
  freeBytes: z.number().nullable().describe("Free space on the backing volume"),
  usedBytes: z.number().nullable().describe("Used space on the backing volume"),
  usedPct: z.number().nullable().describe(
    "Percent of the backing volume in use, 0-100, rounded to one decimal",
  ),
  readonly: z.boolean().nullable().describe(
    "Whether DSM marks the share read-only",
  ),
  capacityReported: z.boolean().describe(
    "False when DSM returned no volume_status for this share — treat capacity fields as unknown, not zero",
  ),
  recordedAt: z.string().describe("ISO-8601 timestamp of this observation"),
});

/**
 * One backing volume, rolled up from the shares that sit on it.
 *
 * Capacity is a property of the VOLUME, not of each share. Emitting a resource
 * per volume means a utilisation contract fires once per real condition rather
 * than once per share — eight shares on one volume are one problem, not eight.
 */
const VolumeSchema = z.object({
  volume: z.string().describe("Volume mount point, e.g. /volume1"),
  shareCount: z.number().describe("Shares observed on this volume"),
  shareNames: z.array(z.string()).describe("Names of those shares, sorted"),
  totalBytes: z.number().describe("Volume capacity"),
  freeBytes: z.number().describe("Free space on the volume"),
  usedBytes: z.number().describe("Used space on the volume"),
  usedPct: z.number().describe("Percent of the volume in use, 0-100"),
  recordedAt: z.string().describe("ISO-8601 timestamp of this observation"),
});

/** Roll-up across every share the account can see. */
const SummarySchema = z.object({
  volumeCount: z.number().describe("Distinct backing volumes observed"),
  shareCount: z.number().describe("Number of shares returned"),
  capacityReportedCount: z.number().describe(
    "How many shares came back with usable volume_status",
  ),
  maxUsedPct: z.number().nullable().describe(
    "Highest volume utilisation seen, or null when nothing reported capacity",
  ),
  truncated: z.boolean().describe(
    "True when DSM reported more shares than were collected — the roll-up is " +
      "then incomplete and utilisation figures may understate reality",
  ),
  recordedAt: z.string().describe("ISO-8601 timestamp of this observation"),
});

/** Hard ceiling on shares collected, so a bad `total` cannot loop forever. */
const MAX_SHARES = 5000;

/** Page size requested from FileStation. */
const PAGE_SIZE = 200;

/**
 * Derive the backing volume from a share's real filesystem path.
 *
 * FileStation's `path` is the SHARE path (`/Videos`), which carries no volume
 * information — only `real_path` (`/volume1/Videos`) does. Requesting
 * `real_path` in `additional` is what makes this derivable at all.
 *
 * @param realPath The share's real filesystem path, when DSM supplied one.
 * @returns The volume mount point, or null when it cannot be determined.
 */
export function volumeOf(realPath: string | null): string | null {
  if (!realPath) return null;
  const match = /^(\/volume(?:USB|SATA)?\d+)/.exec(realPath);
  return match ? match[1] : null;
}

/** A share entry as returned by SYNO.FileStation.List. */
export interface RawShare {
  name?: unknown;
  path?: unknown;
  isdir?: unknown;
  additional?: {
    /** Filesystem path, e.g. `/volume1/Videos`. Only present when requested. */
    real_path?: unknown;
    volume_status?: {
      totalspace?: unknown;
      freespace?: unknown;
      readonly?: unknown;
    };
  };
}

/**
 * Normalise one FileStation share entry.
 *
 * Missing or zero capacity is recorded as `capacityReported: false` with null
 * figures rather than zeros — a share whose volume DSM declined to report is
 * unknown, and letting it read as "0 bytes, 0% used" would make a
 * capacity contract silently pass.
 *
 * @param share The raw entry from DSM.
 * @param recordedAt ISO timestamp for the observation.
 * @returns The normalised `share` resource body.
 */
export function buildShare(
  share: RawShare,
  recordedAt: string,
): z.infer<typeof ShareSchema> {
  const path = str(share.path) ?? "";
  const name = str(share.name) ?? path;
  const status = share.additional?.volume_status;
  const total = num(status?.totalspace);
  const free = num(status?.freespace);
  const usable = total !== null && free !== null && total > 0;
  const used = usable ? total - free : null;

  return {
    name,
    path,
    realPath: str(share.additional?.real_path),
    volume: volumeOf(str(share.additional?.real_path)),
    totalBytes: usable ? total : null,
    freeBytes: usable ? free : null,
    usedBytes: used,
    usedPct: usable && used !== null
      ? Math.round((used / total) * 1000) / 10
      : null,
    readonly: typeof status?.readonly === "boolean" ? status.readonly : null,
    capacityReported: usable,
    recordedAt,
  };
}

/**
 * Collapse shares onto their backing volumes.
 *
 * Only shares with both a resolved volume and reported capacity participate;
 * the rest are counted as `unattributed` so the caller can warn rather than
 * quietly dropping them. Every share on a volume reports that volume's figures,
 * so the first member is representative.
 *
 * @param shares Normalised shares from {@link buildShare}.
 * @param recordedAt ISO timestamp for the observation.
 * @returns Volume roll-ups sorted by mount point, plus the unattributed count.
 */
export function rollUpVolumes(
  shares: Array<z.infer<typeof ShareSchema>>,
  recordedAt: string,
): { volumes: Array<z.infer<typeof VolumeSchema>>; unattributed: number } {
  const reported = shares.filter((s) => s.capacityReported);
  const byVolume = new Map<string, typeof reported>();
  for (const share of reported) {
    if (!share.volume) continue;
    const bucket = byVolume.get(share.volume) ?? [];
    bucket.push(share);
    byVolume.set(share.volume, bucket);
  }

  const volumes = [...byVolume.keys()].sort().map((volume) => {
    const members = byVolume.get(volume)!;
    const first = members[0];
    return {
      volume,
      shareCount: members.length,
      shareNames: members.map((m) => m.name).sort(),
      totalBytes: first.totalBytes ?? 0,
      freeBytes: first.freeBytes ?? 0,
      usedBytes: first.usedBytes ?? 0,
      usedPct: first.usedPct ?? 0,
      recordedAt,
    };
  });

  return { volumes, unattributed: reported.filter((s) => !s.volume).length };
}

/** Turn a volume mount point into a unique data instance name. */
export function volumeInstanceName(volume: string): string {
  return `volume-${volume.replace(/^\//, "").replace(/\//g, "-")}`;
}

/** Read-only DSM shared-folder and capacity model. */
export const model = {
  type: "@khudgins/synology/storage",
  version: "2026.08.12.1",
  description:
    "Read-only Synology shared-folder inventory with per-volume capacity, via " +
    "the FileStation API so it works without a DSM admin account.",
  globalArguments: GlobalArgsSchema,

  resources: {
    share: {
      description: "One shared folder and the capacity of its backing volume",
      schema: ShareSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    volume: {
      description:
        "One backing volume with its capacity, rolled up from the shares on it",
      schema: VolumeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    summary: {
      description: "Roll-up across every share this account can see",
      schema: SummarySchema,
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
        "List shared folders with the capacity of their backing volumes. " +
        "Works with a non-admin DSM account.",
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

        context.logger.info(
          "{name}: listing shares on {url} as {account}",
          {
            name: context.globalArgs.name,
            url: transport.baseUrl,
            account: transport.account,
          },
        );

        return await withSession(transport, async (session) => {
          const recordedAt = new Date().toISOString();

          // FileStation pages `list_share` and reports the full count in
          // `total`. Reading only the first page would silently under-report a
          // NAS with many shares — and an under-reported roll-up is a capacity
          // contract that passes while a volume is full.
          const rawShares: RawShare[] = [];
          let declaredTotal: number | null = null;
          let truncated = false;

          for (let offset = 0;;) {
            const page = await request(
              transport,
              session,
              {
                api: "SYNO.FileStation.List",
                method: "list_share",
                preferredVersion: 2,
                params: {
                  additional: '["real_path","size","volume_status"]',
                  offset: String(offset),
                  limit: String(PAGE_SIZE),
                },
              },
              context.signal,
            );
            const batch = Array.isArray(page.shares)
              ? page.shares as RawShare[]
              : [];
            if (declaredTotal === null) declaredTotal = num(page.total);
            rawShares.push(...batch);

            if (batch.length === 0) break;
            if (declaredTotal !== null && rawShares.length >= declaredTotal) {
              break;
            }
            if (rawShares.length >= MAX_SHARES) {
              truncated = true;
              break;
            }
            offset += batch.length;
          }

          if (
            declaredTotal !== null && rawShares.length < declaredTotal
          ) {
            truncated = true;
          }
          if (truncated) {
            context.logger.warning(
              "collected {got} of {total} shares DSM reported — results are " +
                "incomplete and utilisation may understate reality",
              { got: rawShares.length, total: declaredTotal ?? "unknown" },
            );
          }

          if (rawShares.length === 0) {
            throw new DsmError(
              "FileStation returned no shares — the account may have no share " +
                "permissions, or FileStation may not be installed on this appliance",
            );
          }

          const handles: Array<{ name: string }> = [];
          const shares = rawShares.map((s) => buildShare(s, recordedAt));

          for (const share of shares) {
            // Instance names are unique across specs on disk, so the spec name
            // is prefixed here to avoid colliding with the summary instance.
            const instance = `share-${share.name}`;
            handles.push(await context.writeResource("share", instance, share));
          }

          const reported = shares.filter((s) => s.capacityReported);
          const { volumes, unattributed } = rollUpVolumes(shares, recordedAt);

          for (const vol of volumes) {
            handles.push(
              await context.writeResource(
                "volume",
                volumeInstanceName(vol.volume),
                vol,
              ),
            );
          }

          if (unattributed > 0) {
            context.logger.warning(
              "{count} share(s) reported capacity but no resolvable volume; " +
                "they appear in share resources but not in any volume roll-up",
              { count: unattributed },
            );
          }

          const maxUsedPct = reported.length > 0
            ? Math.max(...reported.map((s) => s.usedPct ?? 0))
            : null;

          if (reported.length < shares.length) {
            context.logger.warning(
              "{missing} of {total} shares returned no volume_status; their " +
                "capacity is recorded as unknown rather than zero",
              {
                missing: shares.length - reported.length,
                total: shares.length,
              },
            );
          }
          context.logger.info(
            "{name}: {count} shares across {vols} volume(s), peak utilisation {pct}",
            {
              name: context.globalArgs.name,
              count: shares.length,
              vols: volumes.length,
              pct: maxUsedPct === null ? "unknown" : `${maxUsedPct}%`,
            },
          );

          handles.push(
            await context.writeResource("summary", "summary-current", {
              volumeCount: volumes.length,
              shareCount: shares.length,
              truncated,
              capacityReportedCount: reported.length,
              maxUsedPct,
              recordedAt,
            }),
          );

          return { dataHandles: handles };
        }, context.signal);
      },
    },
  },
};
