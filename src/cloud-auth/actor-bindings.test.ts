import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTOR_BINDING_CACHE_TTL_MS,
  getActorBindingCachePath,
  readActorBindingForActiveLogin,
  readCachedActorBinding,
  writeCachedActorBinding,
} from "./actor-bindings.js";
import { writeUserOnlyFile } from "./secret-backends.js";
import type { ActorBinding } from "./types.js";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ravi-actor-bindings-"));
  env = { HOME: home, RAVI_STATE_DIR: join(home, ".ravi") };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function binding(overrides: Partial<ActorBinding> = {}): ActorBinding {
  return {
    contactId: "c_luis",
    actorPrincipal: "contact:c_luis",
    consoleUserId: "user_luis",
    orgId: "org_1",
    installationId: "inst_1",
    ...overrides,
  };
}

function plant(record: Record<string, unknown>, contactId = "c_luis") {
  writeCachedActorBinding(binding({ contactId }), env, NOW);
  writeUserOnlyFile(getActorBindingCachePath(contactId, env), `${JSON.stringify(record)}\n`);
}

describe("readCachedActorBinding", () => {
  it("returns the binding as before when no installation is required", () => {
    writeCachedActorBinding(binding({ installationId: "inst_other" }), env, NOW);

    expect(readCachedActorBinding("c_luis", env, NOW)).toMatchObject({ installationId: "inst_other" });
  });

  it("returns null for another installation's binding and keeps the file", () => {
    writeCachedActorBinding(binding({ installationId: "inst_other" }), env, NOW);

    expect(readCachedActorBinding("c_luis", env, NOW, { requireInstallationId: "inst_1" })).toBeNull();
    expect(existsSync(getActorBindingCachePath("c_luis", env))).toBe(true);
    expect(readCachedActorBinding("c_luis", env, NOW)).not.toBeNull();
  });

  it("holds the binding to the active login's installation when one is stored", () => {
    writeCachedActorBinding(binding({ installationId: "inst_other" }), env, NOW);

    const login = (installationId: string | null) => ({ readCredentials: () => ({ installationId }) });
    expect(readActorBindingForActiveLogin("c_luis", env, NOW, login("inst_1"))).toBeNull();
    expect(readActorBindingForActiveLogin("c_luis", env, NOW, login("inst_other"))).not.toBeNull();
    expect(readActorBindingForActiveLogin("c_luis", env, NOW, { readCredentials: () => null })).not.toBeNull();
  });

  it("returns the binding of the required installation", () => {
    writeCachedActorBinding(binding(), env, NOW);

    expect(readCachedActorBinding("c_luis", env, NOW, { requireInstallationId: "inst_1" })).toMatchObject({
      contactId: "c_luis",
      installationId: "inst_1",
    });
  });

  it("deletes a binding whose expiry lies beyond the cache TTL (a planted file)", () => {
    plant({
      version: 1,
      binding: binding(),
      expiresAt: new Date(NOW + 365 * 24 * 60 * 60_000).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });

    expect(readCachedActorBinding("c_luis", env, NOW)).toBeNull();
    expect(existsSync(getActorBindingCachePath("c_luis", env))).toBe(false);
  });

  it("tolerates a minute of clock skew past the TTL", () => {
    plant({
      version: 1,
      binding: binding(),
      expiresAt: new Date(NOW + ACTOR_BINDING_CACHE_TTL_MS + 30_000).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });

    expect(readCachedActorBinding("c_luis", env, NOW)).not.toBeNull();
  });

  it("still deletes an expired binding", () => {
    writeCachedActorBinding(binding(), env, NOW);

    expect(readCachedActorBinding("c_luis", env, NOW + ACTOR_BINDING_CACHE_TTL_MS + 1)).toBeNull();
    expect(existsSync(getActorBindingCachePath("c_luis", env))).toBe(false);
  });
});
