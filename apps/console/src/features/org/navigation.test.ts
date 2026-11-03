import { expect, test } from "bun:test";
import { readableOrganizationSettingsHref } from "./navigation";
import type { OrganizationAction } from "@/shared/organization-access";

test("organization navigation follows explicit read actions, not role or project membership", () => {
  const grants = new Set<OrganizationAction>(["organization.authorization.read"]);
  const allows = (action: OrganizationAction) => grants.has(action);
  expect(readableOrganizationSettingsHref(allows)).toBe("/org/permissions");
  grants.clear(); grants.add("organization.authorization.manage");
  expect(readableOrganizationSettingsHref(allows)).toBeNull();
  grants.add("organization.credentials.read");
  expect(readableOrganizationSettingsHref(allows)).toBe("/org/credentials");
  grants.add("organization.settings.read");
  expect(readableOrganizationSettingsHref(allows)).toBe("/org/settings");
  grants.clear();
  expect(readableOrganizationSettingsHref(allows)).toBeNull();
});
