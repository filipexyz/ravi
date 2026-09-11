import {
  assertObservedSkillExposure,
  assertResolvedSkillPolicySnapshot,
  type ObservedSkillExposure,
} from "./skill-exposure-contract.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";

const CLOSING_TAG = "</ravi-authorized-skills>";

/** Only authorized catalog metadata is advertised; bodies and private scope stay host-owned. */
export function buildSkillExposureText(snapshot: SkillPolicySnapshot): string {
  assertResolvedSkillPolicySnapshot(snapshot);
  const entries = snapshot.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description ?? "",
    reference: skill.resource.path,
  }));
  const body = JSON.stringify(entries).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const id = snapshot.id.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<ravi-authorized-skills snapshot-id="${id}">\n${body}\n${CLOSING_TAG}`;
}

/** Inspect effective authority text only, never user/tool quotes or a reconstructed prompt. */
export function inspectSkillExposureText(text: string, snapshot: SkillPolicySnapshot): ObservedSkillExposure {
  const expected = buildSkillExposureText(snapshot);
  const markers = [...text.matchAll(/<\/?\s*ravi-authorized-skills\b/gi)];
  const start = text.indexOf(expected);
  if (markers.length !== 2 || start < 0 || markers[0]?.index !== start) {
    throw new Error("Invalid authorized skill exposure text.");
  }
  const firstNewline = text.indexOf("\n", start);
  const end = text.indexOf(CLOSING_TAG, firstNewline);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstNewline + 1, end));
  } catch {
    throw new Error("Invalid authorized skill exposure text.");
  }
  if (!Array.isArray(parsed)) throw new Error("Invalid authorized skill exposure text.");
  const ids: string[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") {
      throw new Error("Invalid authorized skill exposure text.");
    }
    ids.push(entry.id);
  }
  const observed: ObservedSkillExposure = {
    snapshotId: snapshot.id,
    mode: "textual",
    advertisedIds: ids,
    discoverableIds: [...ids],
    evidence: "effective-prompt",
  };
  assertObservedSkillExposure(snapshot, observed);
  return observed;
}
