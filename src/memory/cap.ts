/**
 * R3 — Hard cap in characters + overflow check.
 *
 * The cap forces curation: at the boundary, the caller MUST consolidate
 * (merge/demote/stage-remove) rather than accept the overflow.
 *
 * R19 saliency ordering is applied at consolidation time by the caller (LLM
 * curator judgment); this module only provides the deterministic OK/overflow
 * verdict and character accounting.
 */

import type { CapCheckResult } from "./types.js";
import { DEFAULT_MEMORY_CAP_CHARS } from "./types.js";

export interface CapCheckInput {
  currentContent: string;
  proposedContent: string;
  capChars?: number;
}

/**
 * Compare a proposed write against the hard cap.
 *
 * `ok = true` means the proposed content is within budget and MAY be
 * written atomically. `ok = false` MUST force a consolidation pass — the
 * caller should not accept the overflow.
 */
export function checkCap(input: CapCheckInput): CapCheckResult {
  const cap = input.capChars ?? DEFAULT_MEMORY_CAP_CHARS;
  const currentChars = input.currentContent.length;
  const proposedChars = input.proposedContent.length;
  const overflowChars = proposedChars > cap ? proposedChars - cap : 0;
  const ok = overflowChars === 0;

  return {
    ok,
    currentChars,
    proposedChars,
    cap,
    overflowChars,
    ...(ok
      ? {}
      : {
          reason: `R3: proposed ${proposedChars} chars exceeds cap ${cap} by ${overflowChars} — consolidate before writing`,
        }),
  };
}

/**
 * Cheap character count used by callers to enforce R3 outside of a write.
 * Exposed so both the curator prompt (dry-run) and the atomic write share the
 * same accounting.
 */
export function countChars(content: string): number {
  return content.length;
}
