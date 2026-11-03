import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bug,
  Building2,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  Globe2,
  KeyRound,
  Library,
  Link2,
  MessageSquareText,
  Terminal,
  Users,
} from "lucide-react";

/** Audit event types in words. Anything missing falls back to a humanized type. */
const EVENT_TEXT: Record<string, string> = {
  "organization.created": "Created the organization",
  "organization.updated": "Changed the organization name or address",
  "organization_member.added": "Added a member",
  "organization_member.updated": "Changed a member's role",
  "organization_member.removed": "Removed a member",
  "user.created_stub": "Added an email that hasn't signed in yet",
  "slug.rejected": "Tried an address that isn't available",

  "project.created": "Created a project",
  "project.updated": "Changed project settings",

  "page_site.created": "Created a page host",
  "page_site.visibility_updated": "Changed who can open a page host",
  "page_upload_session.created": "Started uploading pages",
  "page_upload_session.failed": "A page upload failed",
  "page_publish.completed": "Published pages",
  "page_publish.failed": "A page publish failed",
  "page_site_release.created": "Prepared a new version of the pages",
  "page_site_release.activated": "Put a new version of the pages live",
  "page_site_release.activation_scaffolded": "Prepared the first version of the pages",
  "page_site.edge_manifest_written": "Updated the live pages",
  "page_site.edge_manifest_pending": "Queued an update to the live pages",
  "page_site.edge_manifest_failed": "Couldn't update the live pages",
  "page_site.edge_manifest_repair": "Repaired the live pages",
  "artifact_version.created_from_publish": "Saved a copy of the published files",
  "page_comment.created": "Commented on a page",
  "page_comment.replied": "Replied to a page comment",
  "page_comment.deleted": "Deleted a page comment",
  "pages.password_policy.disabled": "Removed a page password",
  "pages.password_challenge.denied": "Someone typed a wrong page password",
  "pages.private_route.denied": "Someone was kept out of a private page",
  "pages.private_auth.denied": "Someone was kept out of a private page",
  "pages.connector.exec.denied": "Blocked a page from using a connector",
  "pages.capture.ready": "Took a screenshot of a page",
  "pages.capture.failed": "Couldn't take a screenshot of a page",
  "pages.claim_code.created": "Created a code to claim pages",
  "pages.claim_code.consumed": "Used a code to claim pages",

  "domain_claim.created": "Added a domain",
  "domain_claim.verified": "Verified a domain",
  "domain_claim.verification_failed": "Checked a domain, but its TXT record wasn't found yet",
  "domain_binding.pages.created": "Connected a hostname to pages",
  "domain_binding.pages.rebound": "Moved a hostname to other pages",

  "bases.base.created": "Created a base",
  "bases.base.updated": "Changed a base",
  "bases.base.archived": "Archived a base",
  "bases.base.restored": "Restored a base",
  "bases.property.created": "Added a column to a base",
  "bases.property.updated": "Changed a column in a base",
  "bases.property.deleted": "Deleted a column from a base",
  "bases.property.restored": "Restored a column in a base",
  "bases.property.migrated": "Converted a column in a base",
  "bases.view.created": "Created a view of a base",
  "bases.view.updated": "Changed a view of a base",
  "bases.view.archived": "Archived a view of a base",
  "bases.chart.created": "Created a chart",
  "bases.chart.updated": "Changed a chart",
  "bases.chart.archived": "Archived a chart",
  "bases.row.created": "Added a row to a base",
  "bases.row.updated": "Changed a row in a base",
  "bases.row.purged": "Deleted a row for good",
  "bases.rows.bulk_changed": "Changed many rows in a base",
  "bases.subscription.created": "Started following changes to a base",
  "bases.subscription.revoked": "Stopped following changes to a base",

  "knowledge_source.created": "Added a knowledge source",
  "knowledge_source.ingested": "Read a knowledge source",
  "knowledge_source.deleted": "Deleted a knowledge source",

  "feedback.submitted": "Sent feedback",
  "bug_report.submitted": "Reported a bug",
  "bug_report.comment_appended": "Commented on a bug report",
  "bug_report.status_updated": "Changed a bug report's status",
  "bug_report.deleted": "Deleted a bug report",

  "cli_device_authorization.approved": "Approved a command-line sign-in",
  "cli_session.created": "Signed in from the command line",
  "cli_session.revoked": "Signed out a command-line session",
  "cli_session.refresh_reuse_detected": "Ended a command-line session that was used from two places",

  "github_app.install_completed": "Connected GitHub",
  "github_app.configured": "Changed the GitHub connection",
  "watch.created": "Started a watch",
  "watch.updated": "Changed a watch",
  "watch.deleted": "Stopped a watch",

  "ravi_link.binding.created": "Linked a chat account",
  "ravi_link.binding.reactivated": "Linked a chat account again",
  "ravi_link.binding.updated": "Changed a linked chat account",
  "ravi_link.binding.revoked": "Unlinked a chat account",
  "ravi_link.binding.denied": "Blocked linking a chat account",
  "ravi_link.request.created": "Asked to link a chat account",
  "ravi_link.request.approved": "Approved linking a chat account",
  "ravi_link.request.denied": "Turned down linking a chat account",
  "ravi_link.request.rejected": "Turned down linking a chat account",
  "ravi_link.request.cancelled": "Canceled a request to link a chat account",
  "ravi_link.request.rate_limited": "Too many requests to link a chat account",

  "admin.organization.deleted": "The Ravi team deleted an organization",
  "admin.organization_member.removed": "The Ravi team removed a member",
  "admin.page_site.created": "The Ravi team created a page host",
  "admin.page_site.transferred_in": "The Ravi team moved a page host here",
  "admin.project.transferred_in": "The Ravi team moved a project here",
  "admin.project.transferred_out": "The Ravi team moved a project to another organization",
  "platform_operator.revoked": "Removed someone from the Ravi team",
};

const VERBS: Record<string, string> = {
  activated: "activated",
  added: "added",
  approved: "approved",
  archived: "archived",
  completed: "completed",
  created: "created",
  deleted: "deleted",
  denied: "denied",
  failed: "failed",
  removed: "removed",
  revoked: "revoked",
  updated: "changed",
};

/** "page_site.edge_manifest_written" → "Page site edge manifest written". */
function humanize(type: string) {
  const parts = type.split(".").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (VERBS[last] && parts.length > 1) parts[parts.length - 1] = VERBS[last] as string;
  const text = parts.join(" ").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Something happened";
}

export function eventText(type: string) {
  return EVENT_TEXT[type] ?? humanize(type);
}

export function eventIcon(eventType: string): LucideIcon {
  const type = eventType.replace(/^admin\./, "");
  if (type.startsWith("bases.")) return Database;
  if (type.startsWith("domain")) return Globe2;
  if (type.startsWith("page") || type.startsWith("artifact")) return FileText;
  if (type.startsWith("organization_member") || type.startsWith("user.")) return Users;
  if (type.startsWith("organization") || type.startsWith("slug")) return Building2;
  if (type.startsWith("project")) return FolderOpen;
  if (type.startsWith("knowledge")) return Library;
  if (type.startsWith("feedback")) return MessageSquareText;
  if (type.startsWith("bug_report")) return Bug;
  if (type.startsWith("cli")) return Terminal;
  if (type.startsWith("github") || type.startsWith("watch")) return GitBranch;
  if (type.startsWith("ravi_link")) return Link2;
  if (type.includes("password") || type.includes("auth")) return KeyRound;
  return Activity;
}

/**
 * Steps that always come with another event (a publish writes six), or that
 * only matter to the Ravi team. Hidden unless the viewer asks for everything;
 * failures always show.
 */
const TECHNICAL = new Set([
  "user.created_stub",
  "page_upload_session.created",
  "page_site.edge_manifest_written",
  "page_site.edge_manifest_pending",
  "page_site.edge_manifest_repair",
  "page_site_release.created",
  "page_site_release.activated",
  "page_site_release.activation_scaffolded",
  "artifact_version.created_from_publish",
  "cli_session.refreshed",
  "cli_session.refresh_reuse_race_ignored",
  "watch.create_idempotent",
  "admin.user.created_stub",
  "bug_report.triage_applied",
  "bug_report.triage_enqueued",
  "bug_report.triage_stored",
  "mail.message.ingest",
  "pages.capture.requested",
  "pages.capture_session.created",
  "pages.connector.exec.allowed",
  "pages.password_challenge.allowed",
  "pages.password_session.created",
  "pages.private_auth.return_target_rejected",
  "pages.private_route.allowed",
  "pages.session.created",
  "pages.session.expired",
  "pages.viewer_assertion_audience.deleted",
  "pages.viewer_assertion_audience.upserted",
]);

const TECHNICAL_PREFIXES = ["event_plane.", "agent_inbox.", "mail.decrypt", "mail.route.", "managed_runtime.", "cli.auth."];

export function isTechnicalEvent(type: string) {
  if (type.endsWith(".failed") || type.endsWith("_failed")) return false;
  return TECHNICAL.has(type) || TECHNICAL_PREFIXES.some((prefix) => type.startsWith(prefix));
}
