# Roadmap

## v1.1 — `freshness`

A method that answers "is the thing in this directory still current?" — read
straight off the NAS with the same non-admin account, no agent on any host.

The motivating case: backups written to a share are only useful if they are
recent, and nothing in a typical homelab checks that. Worse, the backups often
live on the same volume as the systems they protect, so the failure that costs
you the data can also cost you the copy.

### Why FileStation can do this

`SYNO.FileStation.List` with `method=list` and `time` in `additional` returns
directory entries with modification times. That is enough to find the newest
file under a path and compare its age to a threshold — and it needs no more
privilege than the `list_share` call the storage type already makes.

### The generalisation problem — the main design work

`/Storage/backups/rundeck` is **one operator's layout**. Nobody else has it. A
method hardcoding any path, filename convention, or retention scheme is useless
to everyone but its author, and the point of publishing is that other people can
run it.

So the watched paths must be **declared by the operator**, not discovered or
assumed. The proposed shape is a list in `globalArguments`, with one method run
covering every entry — a fan-out rather than N invocations, so the per-model
lock is acquired once:

```yaml
globalArguments:
  transport: { ... }
  watch:
    - name: rundeck-backups
      path: /Storage/backups/rundeck
      maxAgeHours: 26 # a nightly job, plus slack
    - name: mysql-dumps
      path: /Storage/backups/mysql
      maxAgeHours: 26
      pattern: "*.sql.gz" # ignore lock files and partials
```

Emit one `freshness` resource per entry, keyed by `name`, so contracts read
naturally and per-path thresholds are independent:

```bash
swamp data query 'specName == "freshness" && attributes.stale == true'
```

Nothing about that is Synology-specific to the author's lab, and an operator
with no backups on their NAS simply declares no `watch` entries and never runs
the method.

### Open questions to settle before writing it

- **Path form.** `list_share` returns share paths (`/Storage`); `real_path` is
  the filesystem path (`/volume1/Storage`). Confirm which form `method=list`
  expects, and normalise so an operator can write either.
- **Recursion.** Backup layouts commonly nest by date (`.../2026/08/12/`). A
  non-recursive newest-file check would report the parent directory's own mtime
  and look permanently stale. Options: a bounded-depth walk, or requiring the
  operator to point at the leaf. Recursion is the friendlier default but costs a
  request per directory — cap the depth and record when the cap was hit, in the
  same spirit as the existing `truncated` flag.
- **Empty is not fresh.** A directory containing no matching files must report a
  distinct state, not "no stale files found". This is the same failure shape as
  `capacityReported`: absent data must never read as a passing result, or the
  contract goes green precisely when the backups stopped being written.
- **Clock skew.** Ages are computed against the appliance's clock, not the
  caller's. Record both timestamps so a skewed NAS is visible rather than
  silently shifting every age.
- **Permissions.** The account needs read on each watched share. A path it
  cannot see must fail loudly for that entry rather than be skipped.

## Smaller items

- **`size` in `additional` is requested and discarded.** Either surface a
  per-share size — which would answer "which share is consuming the volume", a
  question v1 cannot answer — or stop asking for it. FileStation may not return
  anything useful for directories without an expensive recursive walk; confirm
  before committing to it.
- **Share-name sanitisation.** `volumeInstanceName` strips path separators;
  `share-<name>` interpolates the share name raw. DSM forbids separators in
  share names so this is safe today, but the two paths should be consistent.
- **The parked `system` type** (see [`future/`](future/README.md)) can ship once
  it has been verified against an admin-scoped account on real hardware.
