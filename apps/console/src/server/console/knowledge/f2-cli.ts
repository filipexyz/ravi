import { cliApiError } from "@/server/cli/errors";
import type { CliAuthContext } from "@/server/cli/auth";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";

import type { KnowledgeOperatorCaller } from "./caller";
import { buildKnowledgeMirror, listKnowledgeMarksForCaller } from "./mirror";
import { buildKnowledgeDigest, createKnowledgeProposal, getKnowledgeProposalForCaller } from "./proposals";

// F2 segments of `/api/cli/knowledge/*`. The org route (K-C2) has already
// checked the scope, the feature gate and the caller (operator only) before
// dispatching here.

export type KnowledgeF2HandlerInput = {
  caller: KnowledgeOperatorCaller;
  auth: CliAuthContext;
  segments: string[];
  searchParams: URLSearchParams;
  body: unknown;
  requestId: string;
  requestUrl: string;
};

export type KnowledgeF2HandlerResult = { status: number; payload: unknown };

/** Route caps (CONTRACT §5.3): 2.5 MB for `POST proposals`, 256 KB otherwise. */
export const KNOWLEDGE_PROPOSALS_BODY_CAP_BYTES = Math.floor(2.5 * 1024 * 1024);
export const KNOWLEDGE_DEFAULT_BODY_CAP_BYTES = 256 * 1024;

export async function handleKnowledgeProposalCreate(input: KnowledgeF2HandlerInput): Promise<KnowledgeF2HandlerResult> {
  assertBodyWithinCap(input.body, KNOWLEDGE_PROPOSALS_BODY_CAP_BYTES);
  const result = await createKnowledgeProposal({
    caller: input.caller,
    body: input.body,
    requestId: input.requestId,
    origin: raviLinkConsoleOrigin(input.requestUrl),
  });
  return { status: result.created ? 201 : 200, payload: { proposal: result.proposal, deduped: result.deduped } };
}

export async function handleKnowledgeProposalGet(input: KnowledgeF2HandlerInput): Promise<KnowledgeF2HandlerResult> {
  const id = input.segments[1];
  if (!id || input.segments.length !== 2) throw cliApiError(404, "NOT_FOUND", "Proposal not found.");
  const proposal = await getKnowledgeProposalForCaller({ caller: input.caller, id, origin: raviLinkConsoleOrigin(input.requestUrl) });
  return { status: 200, payload: { proposal } };
}

export async function handleKnowledgeDigest(input: KnowledgeF2HandlerInput): Promise<KnowledgeF2HandlerResult> {
  const raw = input.searchParams.get("since")?.trim();
  let since: Date | null = null;
  if (raw) {
    since = new Date(raw);
    if (Number.isNaN(since.getTime())) throw cliApiError(400, "PAYLOAD_INVALID", "since must be an ISO timestamp.");
  }
  const digest = await buildKnowledgeDigest({ caller: input.caller, since, origin: raviLinkConsoleOrigin(input.requestUrl) });
  return { status: 200, payload: digest };
}

export async function handleKnowledgeMirror(input: KnowledgeF2HandlerInput): Promise<KnowledgeF2HandlerResult> {
  assertBodyWithinCap(input.body, KNOWLEDGE_DEFAULT_BODY_CAP_BYTES);
  const mirror = await buildKnowledgeMirror({ auth: input.auth, caller: input.caller, body: input.body });
  return { status: 200, payload: mirror };
}

export async function handleKnowledgeMarks(input: KnowledgeF2HandlerInput): Promise<KnowledgeF2HandlerResult> {
  const url = input.searchParams.get("url")?.trim() || null;
  if (url && url.length > 2048) throw cliApiError(400, "PAYLOAD_INVALID", "url is too long.");
  const payload = await listKnowledgeMarksForCaller({ caller: input.caller, url, origin: raviLinkConsoleOrigin(input.requestUrl) });
  return { status: 200, payload };
}

/** 413 when the parsed body re-serializes past the route cap (the route also checks `content-length`). */
export function assertBodyWithinCap(body: unknown, capBytes: number) {
  if (body === undefined || body === null) return;
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(body), "utf8");
  } catch {
    throw cliApiError(400, "PAYLOAD_INVALID", "Request body is not valid JSON.");
  }
  if (size > capBytes) throw cliApiError(413, "PAYLOAD_INVALID", "Request body is too large.");
}
