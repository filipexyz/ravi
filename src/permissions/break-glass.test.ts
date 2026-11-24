import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ADMIN_PERMISSION_PROFILES } from "./apply-grant.js";
import {
  ADMIN_PROFILE_SLUGS,
  isAdminProfileSlug,
  isBreakGlassCapability,
  profileBreakGlassReasons,
  tagDefinitionBreakGlassReasons,
} from "./break-glass.js";

function cap(value: string) {
  const [permission, objectType, objectId] = value.split(":");
  return { permission: permission!, objectType: objectType!, objectId: objectId! };
}

describe("break-glass power", () => {
  it("keeps the admin profile list identical to the one grants use", () => {
    expect([...ADMIN_PROFILE_SLUGS].sort()).toEqual([...ADMIN_PERMISSION_PROFILES].sort());
  });

  it("counts any admin on system and only the full executable wildcard", () => {
    expect(isBreakGlassCapability(cap("admin:system:*"))).toBe(true);
    expect(isBreakGlassCapability(cap("Admin:System:*"))).toBe(true);
    expect(isBreakGlassCapability(cap("admin:system:anything"))).toBe(true);
    expect(isBreakGlassCapability(cap("execute:executable:*"))).toBe(true);
    expect(isBreakGlassCapability(cap("execute:executable:git*"))).toBe(false);
    expect(isBreakGlassCapability(cap("execute:executable:curl"))).toBe(false);
    expect(isBreakGlassCapability(cap("admin:agent:*"))).toBe(false);
    expect(isBreakGlassCapability(cap("use:tool:*"))).toBe(false);
  });

  it("reads admin profile names in every spelling the contact provider reads", () => {
    for (const spelling of [
      "permission-admin",
      "Permission.Owner",
      "permission_superadmin",
      "PERMISSION:ADMIN",
      "permission-admin-",
    ]) {
      expect(isAdminProfileSlug(spelling)).toBe(true);
    }
    expect(isAdminProfileSlug("permission-administrator")).toBe(false);
  });

  it("names the admin profile and the capabilities that make a profile break-glass", () => {
    expect(profileBreakGlassReasons("permission-owner", [])).toEqual(["permission-owner (admin profile)"]);
    expect(profileBreakGlassReasons("permission-ops", [cap("read:skills:show"), cap("execute:executable:*")])).toEqual([
      "execute:executable:*",
    ]);
    expect(profileBreakGlassReasons("permission-reader", [cap("read:skills:show")])).toEqual([]);
  });

  it("reads a stored definition only when it is a permission profile", () => {
    const metadata = { permissions: { capabilities: ["admin:system:*"] } };
    const base = { slug: "permission-x", label: "x", createdAt: 0, updatedAt: 0 } as never;
    expect(
      tagDefinitionBreakGlassReasons("permission-x", {
        ...(base as object),
        kind: "system",
        source: "permissions",
        metadata,
      } as never),
    ).toEqual(["admin:system:*"]);
    expect(
      tagDefinitionBreakGlassReasons("permission-x", { ...(base as object), kind: "user", metadata } as never),
    ).toEqual([]);
  });

  it("names no channel", () => {
    const source = readFileSync(new URL("./break-glass.ts", import.meta.url), "utf8").toLowerCase();
    for (const channel of ["slack", "whatsapp", "telegram", "omni", "matrix", "discord"]) {
      expect(source).not.toContain(channel);
    }
  });
});
