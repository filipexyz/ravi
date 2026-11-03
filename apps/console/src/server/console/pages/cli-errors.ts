import { cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";

export const PAGE_SITE_SLUG_UNAVAILABLE_CLI_MESSAGE =
  "Project Pages host slug is unavailable. Choose another project slug or ask an admin to move the existing host.";

export const PAGE_SITE_UNAVAILABLE_CLI_MESSAGE =
  "Project Pages host is unavailable. Enable Pages for the project or ask an admin to move/repair the existing host.";

export function pageSiteCliError(error: ConsoleApiError) {
  if (error.payload.error === "slug_unavailable") {
    return cliApiError(400, "PAYLOAD_INVALID", PAGE_SITE_SLUG_UNAVAILABLE_CLI_MESSAGE);
  }
  if (error.payload.error === "invalid_request" || error.payload.error === "validation_failed") {
    return cliApiError(400, "PAYLOAD_INVALID");
  }
  return cliApiError(403, "PROJECT_ACCESS_DENIED");
}

export function pagePublishCliError(error: ConsoleApiError) {
  if (error.payload.error === "publish_forbidden") return cliApiError(403, "PUBLISH_NOT_ALLOWED");
  if (error.payload.error === "publish_unread_comments") {
    return cliApiError(409, "PUBLISH_COMMENTS_UNREAD", error.payload.fieldErrors?.comments);
  }
  if (error.payload.error === "publish_validation_failed") return cliApiError(400, "PAYLOAD_INVALID");
  if (error.payload.error === "publish_route_conflict") return cliApiError(400, "PAYLOAD_INVALID");
  if (error.payload.error === "publish_site_unavailable") {
    return cliApiError(400, "PAYLOAD_INVALID", PAGE_SITE_UNAVAILABLE_CLI_MESSAGE);
  }
  if (error.payload.error === "publish_upload_missing") return cliApiError(400, "PAYLOAD_INVALID");
  if (error.payload.error === "publish_storage_failed") {
    return cliApiError(503, "SERVER_UNAVAILABLE", "Artifact publish is temporarily unavailable.");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE");
}

export function pageRouteVisibilityCliError(error: ConsoleApiError) {
  if (error.payload.error === "invalid_path" || error.payload.error === "validation_failed") {
    return cliApiError(400, "PAYLOAD_INVALID");
  }
  if (error.payload.error === "route_not_found" || error.payload.error === "not_found") {
    return cliApiError(404, "PAYLOAD_INVALID", "The requested Pages route is not active.");
  }
  if (error.payload.error === "publish_unread_comments") {
    return cliApiError(409, "PUBLISH_COMMENTS_UNREAD", error.payload.fieldErrors?.comments);
  }
  if (error.payload.error === "publish_forbidden") {
    return cliApiError(403, "PUBLISH_NOT_ALLOWED");
  }
  if (
    error.payload.error === "project_not_found" ||
    error.payload.error === "project_forbidden" ||
    error.payload.error === "site_not_found" ||
    error.payload.error === "forbidden"
  ) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE", "Pages visibility control is temporarily unavailable.");
}

export function pagePasswordCliError(error: ConsoleApiError) {
  if (
    error.payload.error === "invalid_password" ||
    error.payload.error === "invalid_path" ||
    error.payload.error === "validation_failed"
  ) {
    return cliApiError(400, "PAYLOAD_INVALID");
  }
  if (error.payload.error === "route_not_found") {
    return cliApiError(404, "PAYLOAD_INVALID", "The requested Pages route is not active.");
  }
  if (error.payload.error === "publish_unread_comments") {
    return cliApiError(409, "PUBLISH_COMMENTS_UNREAD", error.payload.fieldErrors?.comments);
  }
  if (error.payload.error === "publish_forbidden") {
    return cliApiError(403, "PUBLISH_NOT_ALLOWED");
  }
  if (
    error.payload.error === "project_not_found" ||
    error.payload.error === "project_forbidden" ||
    error.payload.error === "site_not_found" ||
    error.payload.error === "forbidden"
  ) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE", "Pages password control is temporarily unavailable.");
}
