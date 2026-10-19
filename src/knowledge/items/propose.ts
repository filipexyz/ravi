// `ravi knowledge propose` (contract §13.4): a note, gap, correction or local
// meeting transcript sent to the Console for an org member to approve in the
// browser. The plan is built locally (no Console call) so the dry-run can show
// its size, project and audience without the body.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CONTRACT_EXIT_ERROR, CONTRACT_EXIT_USAGE, ContractError } from "../../cli/agent-contract.js";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import { dbGetInstance } from "../../router/router-db.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { openKnowledgeClient, type KnowledgeClient } from "../client.js";
import { KNOWLEDGE_ISSUE_TEXT } from "../errors.js";
import { knowledgeSettings } from "../settings.js";
import { readLocal } from "../store/local-index.js";
import { foldKnowledgeText } from "../text.js";
import type { ConsoleProposalCreate, ConsoleProposalView, ConsoleRequestedAudience, KnowledgeTurn } from "../types.js";
import { getKnowledgeItem } from "./store.js";

export type KnowledgeProposalKind = "note" | "gap" | "correction" | "transcript";

/** Body limits the Console enforces (§7.2); a transcript is measured in bytes. */
export const KNOWLEDGE_PROPOSAL_LIMITS: Readonly<Record<KnowledgeProposalKind, number>> = Object.freeze({
  note: 8_000,
  gap: 1_000,
  correction: 8_000,
  transcript: 2 * 1024 * 1024,
});

const MAX_EVIDENCE = 20;
const CONSOLE_REF = /^kc:[0-9a-f-]{8,64}$/i;
const MESSAGE_REF = /^km:\d+$/;
const TRANSCRIPT_REF = /^kt:[^:\s]+:\d+$/;
const ITEM_REF = /^ki:[0-9a-f-]{8,64}$/i;
const MEETING_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface ProposalPlanDeps {
  /** The `knowledge.project` setting. */
  defaultProject?: () => string | null;
  /** The instance's channel, or null when no instance has that name. */
  instanceChannel?: (instanceName: string) => string | null;
  /** The text hash of a local ref (`km:`, `kt:`, `ki:`), or null when it is missing. */
  localTextHash?: (ref: string) => string | null;
  /** `~/.ravi/meetings`. */
  meetingsDir?: () => string;
}

export function planKnowledgeProposal(
  input: {
    kind: KnowledgeProposalKind;
    text?: string;
    transcriptKey?: string;
    from?: string[];
    supersedes?: string;
    project?: string | null;
    audience?: string | null;
  },
  deps: ProposalPlanDeps = {},
): {
  plan: ConsoleProposalCreate;
  summary: { kind: string; bytes: number; project: string | null; audience: string };
} {
  const op = "knowledge propose";
  const kind = input.kind;
  if (!(kind in KNOWLEDGE_PROPOSAL_LIMITS)) throw usage(op, "Pass one of --note, --gap, --correction or --transcript.");

  const project = input.project?.trim() || (deps.defaultProject ?? (() => knowledgeSettings().project))()?.trim();
  if (!project) {
    throw usage(
      op,
      "No project: pass --project <ref> or set it once with `ravi settings set knowledge.project <ref>`.",
    );
  }

  let title: string | null = null;
  let body: string;
  if (kind === "transcript") {
    if (input.text?.trim()) throw usage(op, "--transcript takes a local meeting key, not text.");
    const key = input.transcriptKey?.trim() ?? "";
    body = readLocalTranscript(op, key, deps);
    title = key;
  } else {
    body = (input.text ?? "").trim();
    if (!body) throw usage(op, `Give the ${kind} text.`);
    if (body.length > KNOWLEDGE_PROPOSAL_LIMITS[kind]) {
      throw usage(op, `A ${kind} is at most ${KNOWLEDGE_PROPOSAL_LIMITS[kind]} characters.`);
    }
  }

  const requestedAudience = parseAudience(op, kind, input.audience ?? null, deps);
  const evidence = buildEvidence(op, input.from ?? [], deps);
  const supersedes = input.supersedes?.trim() || null;
  if (supersedes && !isKnownRef(supersedes)) throw usage(op, "--supersedes takes a ref such as kc:<id>.");

  const proposal: Omit<ConsoleProposalCreate, "idempotencyKey"> = {
    kind,
    project,
    title,
    body,
    evidence,
    supersedes,
    requestedAudience,
    dedupeKey:
      kind === "gap" && requestedAudience.kind === "contacts"
        ? sha256(requestedAudience.instanceId + foldKnowledgeText(body))
        : null,
  };
  // Hash the complete payload with field boundaries: audience, evidence,
  // supersedes and transcript title must not collide with another plan.
  const plan: ConsoleProposalCreate = { ...proposal, idempotencyKey: sha256(JSON.stringify(proposal)) };
  return {
    plan,
    summary: {
      kind,
      bytes: Buffer.byteLength(body, "utf8"),
      project,
      audience: requestedAudience.kind === "contacts" ? `contacts:${requestedAudience.instanceId}` : "members",
    },
  };
}

export async function submitKnowledgeProposal(
  input: { plan: ConsoleProposalCreate; turn: KnowledgeTurn },
  deps: { client?: KnowledgeClient | null; openClient?: () => Promise<KnowledgeClient | null> } = {},
): Promise<{ proposal: ConsoleProposalView; deduped: boolean }> {
  const client = deps.client !== undefined ? deps.client : await (deps.openClient ?? (() => openKnowledgeClient()))();
  if (!client) throw new CloudAuthError("AUTH_REQUIRED", "Knowledge needs a Ravi Cloud login. Run `ravi login`.");
  return client.createProposal(input.plan, input.turn);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLocalTranscript(op: string, key: string, deps: ProposalPlanDeps): string {
  if (key === "cloud" || key.startsWith("cloud/") || key.startsWith("cloud\\")) {
    throw usage(op, "That meeting is already in the Console (cloud meetings are captured there).");
  }
  if (!MEETING_KEY.test(key) || key === "." || key === "..") {
    throw usage(op, "--transcript takes the name of a meeting folder under ~/.ravi/meetings.");
  }
  const meetingsDir = resolve((deps.meetingsDir ?? (() => join(getRaviStateDir(), "meetings")))());
  const file = join(meetingsDir, key, "transcription.json");
  if (!existsSync(file)) throw usage(op, `No local transcript for meeting ${key}.`);
  // A symlinked folder must not reach outside the meetings dir or into cloud/.
  const real = realpathSync(file);
  const realRoot = realpathSync(meetingsDir);
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || rel.split(sep)[0] === "cloud") {
    throw usage(op, "That meeting is already in the Console (cloud meetings are captured there).");
  }
  const size = statSync(real).size;
  if (size > KNOWLEDGE_PROPOSAL_LIMITS.transcript) {
    throw usage(
      op,
      `The transcript is ${size} bytes; the limit is ${KNOWLEDGE_PROPOSAL_LIMITS.transcript} bytes (2 MB).`,
    );
  }
  const body = readFileSync(real, "utf8");
  if (!body.trim()) throw usage(op, `The transcript of meeting ${key} is empty.`);
  return body;
}

function parseAudience(
  op: string,
  kind: KnowledgeProposalKind,
  raw: string | null,
  deps: ProposalPlanDeps,
): ConsoleRequestedAudience {
  const value = raw?.trim() || "";
  if (!value || value === "members") {
    if (kind === "gap") throw usage(op, "A gap needs --audience contacts:<instance name>.");
    return { kind: "members" };
  }
  if (!value.startsWith("contacts:")) throw usage(op, "--audience is contacts:<instance name> or members.");
  if (kind !== "gap") throw usage(op, `A ${kind} is for members only; drop --audience.`);
  const instanceId = value.slice("contacts:".length).trim();
  const channel = instanceId ? (deps.instanceChannel ?? defaultInstanceChannel)(instanceId) : null;
  if (!channel) throw usage(op, `Instance not found: ${instanceId || "(empty)"}.`);
  return { kind: "contacts", instanceId, label: `${instanceId} (${channel})` };
}

function buildEvidence(op: string, refs: readonly string[], deps: ProposalPlanDeps): ConsoleProposalCreate["evidence"] {
  const unique = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (unique.length > MAX_EVIDENCE) throw usage(op, `At most ${MAX_EVIDENCE} --from refs.`);
  return unique.map((ref) => {
    if (!isKnownRef(ref)) throw usage(op, `Not a knowledge ref: ${ref}. Refs are kc:, km:, kt: or ki:.`);
    // Console refs are hashed by the Console, which holds their text.
    if (CONSOLE_REF.test(ref)) return { ref, textHash: "" };
    const textHash = (deps.localTextHash ?? defaultLocalTextHash)(ref);
    if (!textHash) {
      throw new ContractError(op, "KNOWLEDGE_NOT_FOUND", `Knowledge ref was not found: ${ref}.`, CONTRACT_EXIT_ERROR, {
        retryable: false,
        issues: [KNOWLEDGE_ISSUE_TEXT.KNOWLEDGE_NOT_FOUND as string],
      });
    }
    return { ref, textHash };
  });
}

function isKnownRef(ref: string): boolean {
  return CONSOLE_REF.test(ref) || MESSAGE_REF.test(ref) || TRANSCRIPT_REF.test(ref) || ITEM_REF.test(ref);
}

function defaultLocalTextHash(ref: string): string | null {
  if (ITEM_REF.test(ref)) {
    const item = getKnowledgeItem(ref);
    return item && item.status !== "redacted" ? sha256(item.body) : null;
  }
  return readLocal(ref, 0)?.focus.textHash ?? null;
}

function defaultInstanceChannel(name: string): string | null {
  try {
    return dbGetInstance(name)?.channel ?? null;
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function usage(op: string, message: string): ContractError {
  return new ContractError(op, "USAGE_ERROR", message, CONTRACT_EXIT_USAGE, { retryable: false, issues: [message] });
}
