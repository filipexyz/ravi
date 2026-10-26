/**
 * `omni-broadcast-mp4` — Omni status@broadcast videos older than 7 days.
 *
 * A file is a candidate only when it is **positively matched** to a
 * status@broadcast message: the stored `media_local_path` resolves to this file
 * and its file name equals that message's `external_id`. Anything unmatched,
 * mismatched, or unverifiable (Omni source unavailable) is preserved as
 * in-doubt.
 */

import { existsSync, lstatSync } from "node:fs";
import { walkRegularFiles } from "./fsutil.js";
import type { StoragePolicy } from "./policy.js";
import type { AreaScan, OmniBroadcastProbe, StorageEntry } from "./types.js";

const MAX_DEPTH = 3;

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function scanOmniBroadcastArea(policy: StoragePolicy, now: number, probe: OmniBroadcastProbe): AreaScan {
  const entries: StorageEntry[] = [];
  const limitations: string[] = [];
  const root = policy.omniMediaDir;
  if (!root) {
    return { area: "omni-broadcast-mp4", entries, limitations: ["omni-broadcast-mp4: class disabled"] };
  }
  if (!existsSync(root)) {
    return { area: "omni-broadcast-mp4", entries, limitations: [`omni-broadcast-mp4: root not present (${root})`] };
  }

  const probeResult = probe.listStatusBroadcastMedia();
  if (probeResult.error) {
    limitations.push(
      `omni-broadcast-mp4: Omni status@broadcast source unavailable (${probeResult.error}); every video preserved`,
    );
  }

  const byLocalPath = new Map<string, (typeof probeResult.rows)[number]>();
  for (const row of probeResult.rows) byLocalPath.set(normalizeRelative(row.localPath), row);

  const files = walkRegularFiles(root, { maxDepth: MAX_DEPTH });
  for (const file of files) {
    const name = file.segments[file.segments.length - 1] ?? "";
    if (!name.toLowerCase().endsWith(".mp4")) continue;
    let st;
    try {
      st = lstatSync(file.path);
    } catch {
      limitations.push(`omni-broadcast-mp4: lstat failed (${file.path})`);
      continue;
    }
    const relative = file.segments.join("/");
    const stem = name.slice(0, -".mp4".length);
    const row = byLocalPath.get(relative);
    if (probeResult.error) {
      entries.push({
        area: "omni-broadcast-mp4",
        root,
        path: file.path,
        bytes: st.size,
        decision: "preserved",
        reason: "Omni status@broadcast source unavailable (fail-closed)",
        doubt: true,
      });
      continue;
    }
    if (!row) {
      entries.push({
        area: "omni-broadcast-mp4",
        root,
        path: file.path,
        bytes: st.size,
        decision: "preserved",
        reason: "no matching status@broadcast externalId",
        doubt: true,
      });
      continue;
    }
    if (row.externalId !== stem) {
      entries.push({
        area: "omni-broadcast-mp4",
        root,
        path: file.path,
        bytes: st.size,
        decision: "preserved",
        reason: "status@broadcast externalId does not match the file name",
        doubt: true,
      });
      continue;
    }
    const fileAge = now - st.mtimeMs;
    const messageAge = now - row.postedAt;
    if (fileAge < policy.omniBroadcastMaxAgeMs || messageAge < policy.omniBroadcastMaxAgeMs) {
      entries.push({
        area: "omni-broadcast-mp4",
        root,
        path: file.path,
        bytes: st.size,
        decision: "preserved",
        reason: `younger than the ${policy.omniBroadcastMaxAgeMs}ms threshold`,
      });
      continue;
    }
    entries.push({
      area: "omni-broadcast-mp4",
      root,
      path: file.path,
      bytes: st.size,
      decision: "candidate",
      reason: "matched status@broadcast video older than the 7-day threshold",
    });
  }

  return { area: "omni-broadcast-mp4", entries, limitations };
}
