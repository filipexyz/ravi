import { z } from "zod";
import { inspectSkillExposureText } from "./skill-exposure-text.js";
import type { ObservedSkillExposure } from "./skill-exposure-contract.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";

const requestSchema = z.object({
  instructions: z.string().nullish(),
  input: z.array(
    z
      .object({
        role: z.string().optional(),
        content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]).optional(),
      })
      .passthrough(),
  ),
});

/** Native catalogs are developer instructions in the proven Codex protocol. */
export function inspectCodexSkillPrompt(body: Uint8Array, snapshot: SkillPolicySnapshot): ObservedSkillExposure {
  try {
    const request = requestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    const instructions = request.input
      .filter((item) => item.role === "developer")
      .flatMap((item) =>
        typeof item.content === "string"
          ? [item.content]
          : (item.content ?? []).flatMap((part) => (part.text === undefined ? [] : [part.text])),
      );
    if (request.instructions) instructions.push(request.instructions);
    const text = instructions.join("\n");
    // rust-v0.154.0 ext/skills/src/fragments.rs:39-53 uses this developer block.
    if (text.includes("<skills_instructions>") || text.includes("</skills_instructions>"))
      throw new Error("Native catalog");
    return inspectSkillExposureText(text, snapshot);
  } catch {
    throw new Error("Codex skill prompt does not match the authorized exposure contract.");
  }
}
