/**
 * Safe local PAYLOAD_INVALID copy for CLI/gateway/remote surfaces.
 *
 * Provider bodies stay behind the generic Console message. Local validation
 * reasons (`--html file was not found`, missing project, …) are sanitized and
 * projected as structured issues so remote CLI can show the field/reason
 * without trusting free-form remote `error.message`.
 */

import { stripVTControlCharacters } from "node:util";
import { projectPublicIssues, sanitizePublicValue, type PublicValidationIssue } from "./redaction.js";

const SAFE_LOCAL_PAYLOAD_PREFIX =
  /^(?:--|Missing |Conflicting |Refusing |Invalid |Package |Local |Artifact |Duplicate |Asset |Use only |Choose |Subject |No writable |Non-interactive |Password |Passwords |Console )/;
const PROVIDER_DUMP_PATTERN = /PRIVATE_|SENTINEL_|sk-[A-Za-z0-9]|rctx_|Bearer\s/i;
const ABSOLUTE_PATH_IN_TEXT = /(^|[\s"'`:(=])((?:[A-Za-z]:[\\/]|(?<!\.)\/)[^\s"'`)]+)/g;
const MAX_SOURCE_MESSAGE_LENGTH = 4096;

export function redactAbsolutePathsInText(text: string): string {
  return text.replace(ABSOLUTE_PATH_IN_TEXT, "$1[REDACTED:path]");
}

export function isSafeLocalPayloadMessage(message: string): boolean {
  return SAFE_LOCAL_PAYLOAD_PREFIX.test(message) && !PROVIDER_DUMP_PATTERN.test(message);
}

export function sanitizePayloadInvalidMessage(sourceMessage: string): string | undefined {
  const cleaned = stripVTControlCharacters(sourceMessage)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!cleaned || cleaned.length > MAX_SOURCE_MESSAGE_LENGTH) return undefined;
  if (/https?:\/\//i.test(cleaned) || PROVIDER_DUMP_PATTERN.test(cleaned)) return undefined;
  const sanitized = sanitizePublicValue(cleaned);
  const redacted = redactAbsolutePathsInText(typeof sanitized === "string" ? sanitized : cleaned);
  if (!isSafeLocalPayloadMessage(redacted)) return undefined;
  const projected = projectPublicIssues([{ path: [], code: "invalid", message: redacted }]);
  return projected?.[0]?.message;
}

export function inferPayloadIssuePath(message: string): Array<string | number> {
  const flag = /(?:^Missing )?--([a-z0-9-]+)/.exec(message);
  if (flag?.[1]) {
    return [flag[1].replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())];
  }
  if (/^Missing Console project/i.test(message)) return ["project"];
  return [];
}

export function payloadInvalidIssues(
  sourceMessage: string,
  existing?: PublicValidationIssue[],
): PublicValidationIssue[] | undefined {
  if (existing && existing.length > 0) return existing;
  const message = sanitizePayloadInvalidMessage(sourceMessage);
  if (!message) return undefined;
  return [{ path: inferPayloadIssuePath(message), code: "invalid", message }];
}
