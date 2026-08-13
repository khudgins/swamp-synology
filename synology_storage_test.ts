/**
 * Unit tests for `@khudgins/synology/storage`.
 *
 * The behaviours worth pinning down are the ones a live run cannot easily
 * exercise: a NAS with several volumes, a share DSM declines to report capacity
 * for, and a missing `real_path`. Each of those is a case where the wrong
 * choice makes a capacity contract pass while a volume is full.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildShare,
  model,
  type RawShare,
  rollUpVolumes,
  volumeInstanceName,
  volumeOf,
} from "./synology_storage.ts";

const AT = "2026-01-01T00:00:00.000Z";

/** Build a FileStation share entry for tests. */
function raw(
  name: string,
  realPath: string | null,
  total: number | null,
  free: number | null,
): RawShare {
  const additional: Record<string, unknown> = {};
  if (realPath !== null) additional.real_path = realPath;
  if (total !== null && free !== null) {
    additional.volume_status = { totalspace: total, freespace: free };
  }
  return { name, path: `/${name}`, additional };
}

Deno.test("volumeOf extracts the mount point from a real path", () => {
  assertEquals(volumeOf("/volume1/Videos"), "/volume1");
  assertEquals(volumeOf("/volume12/deep/nested/share"), "/volume12");
  assertEquals(volumeOf("/volumeUSB1/backup"), "/volumeUSB1");
  assertEquals(volumeOf("/volumeSATA2/archive"), "/volumeSATA2");
});

Deno.test("volumeOf returns null rather than guessing", () => {
  // The SHARE path is what DSM returns without `real_path` — it names no
  // volume, and inventing one would attribute capacity to the wrong place.
  assertEquals(volumeOf("/Videos"), null);
  assertEquals(volumeOf(null), null);
  assertEquals(volumeOf(""), null);
  assertEquals(volumeOf("/vol1/x"), null);
});

Deno.test("buildShare computes capacity from volume_status", () => {
  const share = buildShare(raw("logs", "/volume1/logs", 1000, 250), AT);
  assertEquals(share.name, "logs");
  assertEquals(share.realPath, "/volume1/logs");
  assertEquals(share.volume, "/volume1");
  assertEquals(share.totalBytes, 1000);
  assertEquals(share.freeBytes, 250);
  assertEquals(share.usedBytes, 750);
  assertEquals(share.usedPct, 75);
  assertEquals(share.capacityReported, true);
});

Deno.test("buildShare records absent capacity as unknown, never as zero", () => {
  // Zeros here would read as "0% used" and let a capacity contract pass for a
  // share whose real state is simply unknown.
  const share = buildShare(raw("scratch", "/volume2/scratch", null, null), AT);
  assertEquals(share.capacityReported, false);
  assertEquals(share.totalBytes, null);
  assertEquals(share.freeBytes, null);
  assertEquals(share.usedBytes, null);
  assertEquals(share.usedPct, null);
});

Deno.test("buildShare treats a zero-capacity volume as unreported", () => {
  const share = buildShare(raw("empty", "/volume1/empty", 0, 0), AT);
  assertEquals(share.capacityReported, false);
  assertEquals(share.usedPct, null);
});

Deno.test("buildShare coerces DSM's string-typed numbers", () => {
  // DSM returns numerics as JSON numbers or strings inconsistently, even
  // within one response.
  const share = buildShare(
    {
      name: "mixed",
      path: "/mixed",
      additional: {
        real_path: "/volume1/mixed",
        volume_status: { totalspace: "2000", freespace: "500" },
      },
    },
    AT,
  );
  assertEquals(share.totalBytes, 2000);
  assertEquals(share.usedBytes, 1500);
  assertEquals(share.usedPct, 75);
});

Deno.test("buildShare survives a share with no real_path", () => {
  const share = buildShare(raw("odd", null, 1000, 500), AT);
  assertEquals(share.realPath, null);
  assertEquals(share.volume, null);
  assertEquals(share.capacityReported, true);
});

Deno.test("rollUpVolumes collapses many shares onto one volume", () => {
  const shares = [
    buildShare(raw("Videos", "/volume1/Videos", 1000, 360), AT),
    buildShare(raw("Music", "/volume1/Music", 1000, 360), AT),
    buildShare(raw("logs", "/volume1/logs", 1000, 360), AT),
  ];
  const { volumes, unattributed } = rollUpVolumes(shares, AT);

  // One capacity condition, not three.
  assertEquals(volumes.length, 1);
  assertEquals(volumes[0].volume, "/volume1");
  assertEquals(volumes[0].shareCount, 3);
  assertEquals(volumes[0].shareNames, ["Music", "Videos", "logs"]);
  assertEquals(volumes[0].usedPct, 64);
  assertEquals(unattributed, 0);
});

Deno.test("rollUpVolumes keeps distinct volumes separate and sorted", () => {
  const shares = [
    buildShare(raw("b", "/volume2/b", 500, 100), AT),
    buildShare(raw("a", "/volume1/a", 1000, 900), AT),
  ];
  const { volumes } = rollUpVolumes(shares, AT);

  assertEquals(volumes.map((v) => v.volume), ["/volume1", "/volume2"]);
  assertEquals(volumes[0].usedPct, 10);
  assertEquals(volumes[1].usedPct, 80);
});

Deno.test("rollUpVolumes excludes shares of unknown capacity", () => {
  const shares = [
    buildShare(raw("known", "/volume1/known", 1000, 500), AT),
    buildShare(raw("unknown", "/volume1/unknown", null, null), AT),
  ];
  const { volumes } = rollUpVolumes(shares, AT);

  // The unknown share must not inflate the volume's share count, and must not
  // contribute phantom zero-capacity figures.
  assertEquals(volumes.length, 1);
  assertEquals(volumes[0].shareCount, 1);
  assertEquals(volumes[0].shareNames, ["known"]);
});

Deno.test("rollUpVolumes reports shares it could not attribute", () => {
  const shares = [
    buildShare(raw("ok", "/volume1/ok", 1000, 500), AT),
    buildShare(raw("orphan", null, 1000, 500), AT),
  ];
  const { volumes, unattributed } = rollUpVolumes(shares, AT);

  assertEquals(volumes.length, 1);
  // Surfaced rather than silently dropped — the caller logs a warning.
  assertEquals(unattributed, 1);
});

Deno.test("rollUpVolumes handles an empty share list", () => {
  const { volumes, unattributed } = rollUpVolumes([], AT);
  assertEquals(volumes, []);
  assertEquals(unattributed, 0);
});

Deno.test("volumeInstanceName produces collision-free instance names", () => {
  assertEquals(volumeInstanceName("/volume1"), "volume-volume1");
  assertEquals(volumeInstanceName("/volumeUSB1"), "volume-volumeUSB1");
  // Instance names map to storage paths, so no stray separators may survive.
  assertEquals(volumeInstanceName("/volume1/sub"), "volume-volume1-sub");
});

// ---------------------------------------------------------------------------
// discover.execute — the pagination path.
//
// FileStation pages `list_share` and reports the full count in `total`. Reading
// only the first page would under-report a NAS with many shares, and an
// under-reported roll-up is a capacity contract that passes while a volume is
// full. A live appliance with eight shares returns a single page, so this path
// is only reachable under a stub.
// ---------------------------------------------------------------------------

/** Minimal method context capturing what the method writes and logs. */
function stubContext() {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const warnings: string[] = [];
  return {
    written,
    warnings,
    context: {
      globalArgs: {
        name: "test-nas",
        transport: {
          baseUrl: "https://nas.example.com:5001",
          account: "svc",
          password: "pw",
          // deno-lint-ignore no-explicit-any
        } as any,
      },
      logger: {
        info: () => {},
        warning: (m: string) => warnings.push(m),
      },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

/** Stub DSM: a fixed catalogue, a login, and a paged `list_share`. */
function dsmStub(pages: RawShare[][], declaredTotal: number) {
  return (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

    if (url.includes("query.cgi")) {
      return json({
        success: true,
        data: {
          "SYNO.API.Auth": { path: "entry.cgi", minVersion: 1, maxVersion: 6 },
          "SYNO.FileStation.List": {
            path: "entry.cgi",
            minVersion: 1,
            maxVersion: 2,
          },
        },
      });
    }
    if (url.includes("method=logout")) return json({ success: true });
    if (url.includes("list_share")) {
      const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
      // Pages are keyed by how many have already been collected.
      const index = pages.findIndex((_, i) =>
        pages.slice(0, i).reduce((n, p) => n + p.length, 0) === offset
      );
      const batch = index >= 0 ? pages[index] : [];
      return json({
        success: true,
        data: { total: declaredTotal, shares: batch },
      });
    }
    // Anything else is the login POST.
    return json({ success: true, data: { sid: "test-sid" } });
  };
}

Deno.test("discover collects every page DSM reports", async () => {
  const pages = [
    [raw("a", "/volume1/a", 1000, 400), raw("b", "/volume1/b", 1000, 400)],
    [raw("c", "/volume2/c", 500, 250), raw("d", "/volume2/d", 500, 250)],
    [raw("e", "/volume1/e", 1000, 400)],
  ];
  const { context, written, warnings } = stubContext();
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = dsmStub(pages, 5) as any;
  try {
    await model.methods.discover.execute({}, context);
  } finally {
    globalThis.fetch = original;
  }

  // All five shares across three pages, not just the first page's two.
  assertEquals(written.filter((w) => w.spec === "share").length, 5);
  // Two distinct volumes, each rolled up once.
  assertEquals(written.filter((w) => w.spec === "volume").length, 2);

  const summary = written.find((w) => w.spec === "summary")!
    .data as Record<string, unknown>;
  assertEquals(summary.shareCount, 5);
  assertEquals(summary.volumeCount, 2);
  assertEquals(summary.truncated, false);
  assertEquals(warnings.length, 0);
});

Deno.test("discover flags truncation when DSM reports more than it returns", async () => {
  // DSM claims 10 shares but stops returning them after the first page — the
  // roll-up is then incomplete and must say so rather than look complete.
  const pages = [[raw("a", "/volume1/a", 1000, 100)]];
  const { context, written, warnings } = stubContext();
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = dsmStub(pages, 10) as any;
  try {
    await model.methods.discover.execute({}, context);
  } finally {
    globalThis.fetch = original;
  }

  const summary = written.find((w) => w.spec === "summary")!
    .data as Record<string, unknown>;
  assertEquals(summary.truncated, true);
  assertEquals(summary.shareCount, 1);
  assertEquals(warnings.some((w) => w.includes("collected")), true);
});
