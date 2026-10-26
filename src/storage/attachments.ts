/**
 * `instance-attachments` — inbound WhatsApp media saved by the main instance
 * under `~/ravi/main/attachments`, older than 90 days.
 *
 * Only direct children that look like a saved attachment
 * (`<epochMs>-<externalId>.<ext>`) are in the class. Anything else in the
 * directory is preserved and visible as in-doubt.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StoragePolicy } from "./policy.js";
import type { AreaScan, StorageEntry } from "./types.js";

/** Closed structural allowlist for attachment file names. */
const ATTACHMENT_NAME = /^\d{10,16}-[A-Za-z0-9]{8,}\.[A-Za-z0-9]{2,6}$/;

export function isAttachmentName(name: string): boolean {
  return ATTACHMENT_NAME.test(name);
}

export function scanAttachmentsArea(policy: StoragePolicy, now: number): AreaScan {
  const entries: StorageEntry[] = [];
  const limitations: string[] = [];
  const root = policy.attachmentsDir;
  if (!root) {
    return { area: "instance-attachments", entries, limitations: ["instance-attachments: class disabled"] };
  }
  if (!existsSync(root)) {
    return {
      area: "instance-attachments",
      entries,
      limitations: [`instance-attachments: root not present (${root})`],
    };
  }

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return {
      area: "instance-attachments",
      entries,
      limitations: [`instance-attachments: root not readable (${root})`],
    };
  }

  for (const name of names) {
    const path = join(root, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      limitations.push(`instance-attachments: lstat failed (${path})`);
      continue;
    }
    if (st.isSymbolicLink()) {
      entries.push({
        area: "instance-attachments",
        root,
        path,
        bytes: 0,
        decision: "preserved",
        reason: "symlink not followed",
      });
      continue;
    }
    if (!st.isFile()) {
      // Subdirectories and special files are outside the flat attachment surface.
      continue;
    }
    if (!isAttachmentName(name)) {
      entries.push({
        area: "instance-attachments",
        root,
        path,
        bytes: st.size,
        decision: "preserved",
        reason: "name does not match the attachment allowlist",
        doubt: true,
      });
      continue;
    }
    const age = now - st.mtimeMs;
    if (age < policy.attachmentsMaxAgeMs) {
      entries.push({
        area: "instance-attachments",
        root,
        path,
        bytes: st.size,
        decision: "preserved",
        reason: `younger than the ${policy.attachmentsMaxAgeMs}ms threshold`,
      });
      continue;
    }
    entries.push({
      area: "instance-attachments",
      root,
      path,
      bytes: st.size,
      decision: "candidate",
      reason: "attachment older than the 90-day threshold",
    });
  }

  return { area: "instance-attachments", entries, limitations };
}
