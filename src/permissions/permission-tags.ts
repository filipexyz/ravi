/** Provider-owned permission tags: the slug spelling the contact-policy provider reads. */
export const PERMISSION_TAG_PREFIX = "permission-";

export function normalizePermissionTag(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

/**
 * True when a tag slug, in any spelling (`permission.admin`, `Permission:Owner`),
 * is a provider-owned permission tag that turns into capabilities.
 */
export function isPermissionPolicyTag(value: string): boolean {
  return normalizePermissionTag(value)?.startsWith(PERMISSION_TAG_PREFIX) ?? false;
}
