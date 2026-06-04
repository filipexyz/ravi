import type { WatchConnectorDefinition, WatchConnectorEventType, WatchProvider } from "./types.js";

const GITHUB_CONSOLE_SUPPORTED_NOW = new Set([
  "push.branch",
  "push.default_branch",
  "push.tag",
  "pull_request.opened",
  "pull_request.closed",
  "pull_request.merged",
  "pull_request.reopened",
  "issue.opened",
  "issue.closed",
  "workflow_run.completed",
]);

const GITHUB_EVENT_TYPES: WatchConnectorEventType[] = [
  githubEvent("release.published", "Release published", "console", "full"),
  githubEvent("release.prereleased", "Prerelease published", "console", "full"),
  githubEvent("release.edited", "Release edited", "console", "derived"),
  githubEvent("release.deleted", "Release deleted", "console", "best_effort"),
  githubEvent("branch.created", "Branch created", "console", "derived"),
  githubEvent("branch.deleted", "Branch deleted", "console", "derived"),
  githubEvent("tag.created", "Tag created", "console", "derived"),
  githubEvent("tag.deleted", "Tag deleted", "console", "derived"),
  githubEvent("push.branch", "Branch pushed", "console", "best_effort"),
  githubEvent("push.default_branch", "Default branch pushed", "console", "best_effort"),
  githubEvent("push.tag", "Tag pushed", "console", "best_effort"),
  githubEvent("pull_request.opened", "Pull request opened", "console", "derived"),
  githubEvent("pull_request.reopened", "Pull request reopened", "console", "derived"),
  githubEvent("pull_request.ready_for_review", "Pull request ready for review", "console", "derived"),
  githubEvent("pull_request.converted_to_draft", "Pull request converted to draft", "console", "derived"),
  githubEvent("pull_request.synchronize", "Pull request synchronized", "console", "derived"),
  githubEvent("pull_request.review_requested", "Pull request review requested", "console", "best_effort"),
  githubEvent("pull_request.closed", "Pull request closed", "console", "derived"),
  githubEvent("pull_request.merged", "Pull request merged", "console", "derived"),
  githubEvent("pull_request_review.submitted", "Pull request review submitted", "console", "full"),
  githubEvent("pull_request_review.approved", "Pull request approved", "console", "full"),
  githubEvent("pull_request_review.changes_requested", "Pull request changes requested", "console", "full"),
  githubEvent("pull_request_review.dismissed", "Pull request review dismissed", "console", "derived"),
  githubEvent("pull_request_review.commented", "Pull request review commented", "console", "full"),
  githubEvent("issue.opened", "Issue opened", "console", "derived"),
  githubEvent("issue.closed", "Issue closed", "console", "derived"),
  githubEvent("issue.reopened", "Issue reopened", "console", "derived"),
  githubEvent("issue.labeled", "Issue labeled", "console", "derived"),
  githubEvent("issue.assigned", "Issue assigned", "console", "derived"),
  githubEvent("issue.edited", "Issue edited", "console", "best_effort"),
  githubEvent("issue_comment.created", "Issue comment created", "console", "full"),
  githubEvent("pull_request_comment.created", "Pull request comment created", "console", "full"),
  githubEvent("workflow_run.requested", "Workflow run requested", "console", "derived"),
  githubEvent("workflow_run.in_progress", "Workflow run in progress", "console", "derived"),
  githubEvent("workflow_run.completed", "Workflow run completed", "console", "full"),
  githubEvent("workflow_run.succeeded", "Workflow run succeeded", "console", "full"),
  githubEvent("workflow_run.failed", "Workflow run failed", "console", "full"),
  githubEvent("workflow_run.cancelled", "Workflow run cancelled", "console", "full"),
  githubEvent("check_run.completed", "Check run completed", "console", "best_effort"),
  githubEvent("check_suite.completed", "Check suite completed", "console", "best_effort"),
  githubEvent("repository.archived", "Repository archived", "console", "derived"),
  githubEvent("repository.unarchived", "Repository unarchived", "console", "derived"),
  githubEvent("repository.renamed", "Repository renamed", "console", "derived"),
  githubEvent("repository.transferred", "Repository transferred", "console", "best_effort"),
  githubEvent("repository.publicized", "Repository made public", "console", "derived"),
  githubEvent("repository.privatized", "Repository made private", "console", "derived"),
  githubEvent("star.created", "Star created", "console", "best_effort"),
];

const NPM_EVENT_TYPES: WatchConnectorEventType[] = [
  event("package.version_published", "Package version published", "local", "full"),
  event("package.dist_tag_changed", "Package dist-tag changed", "local", "derived"),
];

export const WATCH_CONNECTORS: WatchConnectorDefinition[] = [
  {
    id: "github",
    label: "GitHub",
    description: "Watch repository activity through Console GitHub App webhooks or local polling fallback.",
    placements: ["console", "local"],
    defaultPlacement: "auto",
    defaultEventTypes: ["push.default_branch"],
    eventTypes: GITHUB_EVENT_TYPES,
  },
  {
    id: "npm",
    label: "npm",
    description: "Watch npm package metadata for published versions and dist-tag changes.",
    placements: ["local", "console"],
    defaultPlacement: "auto",
    defaultEventTypes: ["package.version_published"],
    eventTypes: NPM_EVENT_TYPES,
  },
];

export function listWatchConnectors(provider?: string | null): WatchConnectorDefinition[] {
  const normalized = provider?.trim();
  if (!normalized) return WATCH_CONNECTORS;
  return WATCH_CONNECTORS.filter((connector) => connector.id === normalized);
}

export function getWatchConnector(provider: WatchProvider): WatchConnectorDefinition | null {
  return WATCH_CONNECTORS.find((connector) => connector.id === provider) ?? null;
}

export function resolveEventTypes(provider: WatchProvider, requested: string[] | undefined): string[] {
  const connector = getWatchConnector(provider);
  const eventTypes = requested?.length ? requested : connector?.defaultEventTypes;
  if (!eventTypes?.length) throw new Error(`No default event type configured for watch provider: ${provider}`);
  const supported = new Set(connector?.eventTypes.map((eventType) => eventType.eventType) ?? []);
  const invalid = connector ? eventTypes.filter((eventType) => !supported.has(eventType)) : [];
  if (invalid.length > 0) {
    throw new Error(`Unsupported ${provider} watch event type(s): ${invalid.join(", ")}`);
  }
  return [...new Set(eventTypes.map((eventType) => eventType.trim()).filter(Boolean))];
}

export function eventSubject(provider: WatchProvider, eventType: string): string {
  return `ravi.watch.${provider}.${eventType}`;
}

function githubEvent(
  eventType: string,
  label: string,
  recommendedPlacement: "local" | "console",
  fidelity: WatchConnectorEventType["fidelity"],
): WatchConnectorEventType {
  return event(eventType, label, recommendedPlacement, fidelity, {
    consoleSupport: GITHUB_CONSOLE_SUPPORTED_NOW.has(eventType) ? "supported" : "roadmap",
    localSupport: "roadmap",
  });
}

function event(
  eventType: string,
  label: string,
  recommendedPlacement: "local" | "console",
  fidelity: WatchConnectorEventType["fidelity"],
  support: Pick<WatchConnectorEventType, "consoleSupport" | "localSupport"> = {},
): WatchConnectorEventType {
  return {
    eventType,
    label,
    placements: ["local", "console"],
    recommendedPlacement,
    fidelity,
    webhookOnly: fidelity === "webhook_only",
    ...support,
  };
}
