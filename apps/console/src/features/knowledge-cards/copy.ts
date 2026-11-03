// Fixed copy for the Knowledge one-card pages. Error codes come from the card
// POST routes (`?error=<code>`); unknown codes get a generic line.

const ERROR_COPY: Record<string, string> = {
  faq_site_unavailable: "This project has no Pages host yet.",
  faq_site_not_public:
    "This project's Pages host is private, so clients could not open /faq. Make the host public first (`ravi pages visibility <site> public --execute`), then publish again.",
  faq_route_taken: "This project already has its own /faq page.",
  faq_busy: "Someone else is publishing /faq right now. Try again in a moment.",
  faq_managed: "This is the Console's own /faq page. It is marked again every time an answer is published.",
  knowledge_route_not_captured: "This page has not been read yet; try again in a minute.",
  knowledge_mark_stale: "The page changed while you were reviewing it. Review what it says now, then decide again.",
  knowledge_proposal_closed: "This was already decided or it expired.",
  knowledge_proposal_forbidden: "Only project admins can decide this.",
  knowledge_mark_forbidden: "Only project admins can change who hears this page.",
  knowledge_proposal_not_found: "This item no longer exists.",
  knowledge_proposal_empty: "There is nothing in it to keep.",
  knowledge_proposal_too_large: "It is too large to keep.",
  knowledge_proposal_source_deleted: "Its content was deleted, so it cannot be kept again.",
  validation_failed: "Write an answer (up to 2,000 characters) and the question as it should appear on /faq.",
  invalid_decision: "That action does not apply here.",
  invalid_action: "That action does not apply here.",
  no_audience: "Choose who will hear this page.",
  impersonated: "Decisions are not allowed while impersonating someone.",
  publish_storage_failed: "The page could not be uploaded. Try again.",
};

export function knowledgeCardErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_COPY[code] ?? "Nothing changed. Try again.";
}

export const PROPOSAL_DONE_COPY: Record<string, { title: string; body: string }> = {
  publish: { title: "Answer published", body: "The answer is on /faq, and the contacts who asked will get it." },
  dismiss: { title: "Question dismissed", body: "Nothing was published." },
  approve: { title: "Approved", body: "It is now part of this project's knowledge." },
  reject: { title: "Rejected", body: "Nothing was kept." },
};

export const ROUTE_DONE_COPY: Record<string, string> = {
  mark: "This page is marked. The chosen audiences hear this version.",
  reapprove: "Re-approved. The chosen audiences hear the current version.",
  unmark: "This page is no longer marked. Nobody outside the project hears it.",
};

export function proposalKindLabel(kind: string) {
  switch (kind) {
    case "gap":
      return "Question from a contact";
    case "correction":
      return "Correction";
    case "transcript":
      return "Meeting transcript";
    default:
      return "Note";
  }
}

export function routeStateLabel(state: "unmarked" | "active" | "suspended") {
  return state === "active" ? "Marked" : state === "suspended" ? "Needs re-approval" : "Not marked";
}
