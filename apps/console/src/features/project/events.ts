import type { Event } from "@/features/console/types";

export type EventArea = "pages" | "bases" | "project" | "other";

type EventWords = {
  /** What happened, as a short sentence without the actor. */
  text: string;
  area: EventArea;
  /** Steps a person rarely needs: shown only when "technical steps" is on. */
  technical?: boolean;
  tone?: "err";
};

/**
 * Audit actions in words. Unknown actions fall back to a readable version of
 * the action name, so a new server event still shows up.
 */
const WORDS: Record<string, EventWords> = {
  "project.created": { area: "project", text: "Created the project" },
  "project.updated": { area: "project", text: "Changed the project's settings" },
  "slug.rejected": { area: "project", text: "Tried a slug that isn't available", technical: true },

  "page_site.created": { area: "pages", text: "Created a host" },
  "page_site.visibility_updated": { area: "pages", text: "Changed who can open a host's pages" },
  "page_publish.completed": { area: "pages", text: "Published a page" },
  "page_publish.failed": { area: "pages", text: "A page couldn't be published", tone: "err" },
  "page_site_release.activated": { area: "pages", text: "Made a version of the pages live" },
  "page_site_release.created": { area: "pages", text: "Saved a version of the pages", technical: true },
  "page_site_release.activation_scaffolded": { area: "pages", text: "Prepared a host's first version", technical: true },
  "page_upload_session.created": { area: "pages", text: "Started uploading a page", technical: true },
  "page_upload_session.failed": { area: "pages", text: "A page upload failed", tone: "err" },
  "artifact_version.created_from_publish": { area: "pages", text: "Stored the files of a page", technical: true },
  "page_site.edge_manifest_pending": { area: "pages", text: "Started updating a host", technical: true },
  "page_site.edge_manifest_written": { area: "pages", text: "Finished updating a host", technical: true },
  "page_site.edge_manifest_repair": { area: "pages", text: "Repaired a host", technical: true },
  "page_site.edge_manifest_failed": { area: "pages", text: "A host couldn't be updated", tone: "err" },
  "page_comment.created": { area: "pages", text: "Commented on a page" },
  "page_comment.replied": { area: "pages", text: "Replied to a comment on a page" },
  "page_comment.deleted": { area: "pages", text: "Deleted a comment on a page" },
  "pages.capture.requested": { area: "pages", text: "Asked for a page preview", technical: true },
  "pages.capture.ready": { area: "pages", text: "Made a page preview", technical: true },
  "pages.capture.failed": { area: "pages", text: "A page preview failed", technical: true },
  "pages.capture_session.created": { area: "pages", text: "Opened a page to take its preview", technical: true },
  "pages.password_policy.disabled": { area: "pages", text: "Removed a page's password" },
  "pages.password_challenge.allowed": { area: "pages", text: "Opened a page with its password", technical: true },
  "pages.password_challenge.denied": { area: "pages", text: "Entered a wrong page password", technical: true },
  "pages.password_session.created": { area: "pages", text: "Opened a password-protected page", technical: true },
  "pages.session.created": { area: "pages", text: "Signed in to open pages", technical: true },
  "pages.session.expired": { area: "pages", text: "A page sign-in expired", technical: true },
  "pages.private_route.allowed": { area: "pages", text: "Opened a private page", technical: true },
  "pages.private_route.denied": { area: "pages", text: "Was refused a private page", technical: true },
  "pages.private_auth.denied": { area: "pages", text: "Was refused sign-in to a page", technical: true },
  "pages.private_auth.return_target_rejected": { area: "pages", text: "Tried to return to an unknown page", technical: true },
  "pages.claim_code.created": { area: "pages", text: "Started a page sign-in", technical: true },
  "pages.claim_code.consumed": { area: "pages", text: "Finished a page sign-in", technical: true },
  "pages.connector.exec.allowed": { area: "pages", text: "A page read or wrote data", technical: true },
  "pages.connector.exec.denied": { area: "pages", text: "A page was refused data", technical: true },
  "pages.viewer_assertion_audience.upserted": { area: "pages", text: "Let a page identify its viewer to a service" },
  "pages.viewer_assertion_audience.deleted": { area: "pages", text: "Stopped a page identifying its viewer to a service" },

  "domain_claim.created": { area: "pages", text: "Added a domain" },
  "domain_claim.verified": { area: "pages", text: "Verified a domain" },
  "domain_claim.verification_failed": { area: "pages", text: "A domain couldn't be verified yet", tone: "err" },
  "domain_binding.pages.created": { area: "pages", text: "Connected a domain to a host" },
  "domain_binding.pages.rebound": { area: "pages", text: "Moved a domain to another host" },
  "domain_binding.ready": { area: "pages", text: "A domain started serving pages" },
  "domain_binding.check_pending": { area: "pages", text: "Checked a domain that isn't ready yet", technical: true },

  "bases.base.created": { area: "bases", text: "Created a base" },
  "bases.base.updated": { area: "bases", text: "Changed a base" },
  "bases.base.archived": { area: "bases", text: "Archived a base" },
  "bases.base.restored": { area: "bases", text: "Restored a base" },
  "bases.property.created": { area: "bases", text: "Added a column to a base" },
  "bases.property.updated": { area: "bases", text: "Changed a column of a base" },
  "bases.property.migrated": { area: "bases", text: "Changed the type of a column" },
  "bases.property.deleted": { area: "bases", text: "Removed a column from a base" },
  "bases.property.restored": { area: "bases", text: "Restored a column of a base" },
  "bases.view.created": { area: "bases", text: "Created a view of a base" },
  "bases.view.updated": { area: "bases", text: "Changed a view of a base" },
  "bases.view.archived": { area: "bases", text: "Archived a view of a base" },
  "bases.chart.created": { area: "bases", text: "Created a chart" },
  "bases.chart.updated": { area: "bases", text: "Changed a chart" },
  "bases.chart.archived": { area: "bases", text: "Archived a chart" },
  "bases.row.purged": { area: "bases", text: "Deleted a row for good" },
  "bases.subscription.created": { area: "bases", text: "Started following changes to a base" },
  "bases.subscription.revoked": { area: "bases", text: "Stopped following changes to a base" },

  "github_app.install_completed": { area: "project", text: "Connected GitHub" },
  "github_app.configured": { area: "project", text: "Changed the GitHub connection" },
  "watch.created": { area: "project", text: "Created a watch" },
  "watch.create_idempotent": { area: "project", text: "Reused an existing watch", technical: true },
  "watch.updated": { area: "project", text: "Changed a watch" },
  "watch.deleted": { area: "project", text: "Deleted a watch" },

  "feedback.submitted": { area: "other", text: "Sent feedback" },
  "knowledge_source.created": { area: "other", text: "Added a knowledge source" },
  "knowledge_source.ingested": { area: "other", text: "Read a knowledge source" },
  "knowledge_source.deleted": { area: "other", text: "Removed a knowledge source" },
  "bug_report.submitted": { area: "other", text: "Reported a bug" },
};

function fallbackWords(type: string): EventWords {
  const area: EventArea = type.startsWith("bases.")
    ? "bases"
    : type.startsWith("page") || type.startsWith("domain")
      ? "pages"
      : type.startsWith("project")
        ? "project"
        : "other";
  const text = type.replace(/[._]+/g, " ").trim();
  return {
    area,
    technical: false,
    text: text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Something changed",
    tone: /(failed|denied|rejected)$/.test(type) ? "err" : undefined,
  };
}

export function eventWords(type: string): EventWords {
  return WORDS[type] ?? fallbackWords(type);
}

/**
 * Hides the steps a person doesn't need. A publish writes an upload session,
 * a version, a release and two host updates; only "Published a page" stays.
 * A release made live within seconds of a publish is that publish's own.
 */
export function visibleEvents(events: Event[], includeTechnical: boolean) {
  if (includeTechnical) return events;
  const publishTimes = events.filter((event) => event.type === "page_publish.completed").map((event) => event.t);
  return events.filter((event) => {
    const words = eventWords(event.type);
    if (words.technical) return false;
    if (event.type === "page_site_release.activated") {
      return !publishTimes.some((time) => Math.abs(time - event.t) < 5_000);
    }
    return true;
  });
}

export function actorName(
  actor: string,
  context: { currentUserId: string | null; names: Map<string, string> },
) {
  if (actor === "system") return "Ravi";
  if (actor === "anonymous") return "Local developer";
  if (context.currentUserId && actor === context.currentUserId) return "You";
  return context.names.get(actor) ?? "A member";
}
