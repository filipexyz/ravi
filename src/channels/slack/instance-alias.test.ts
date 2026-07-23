import { describe, expect, it } from "bun:test";
import type { InstanceConfig } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import {
  buildSlackInstanceProvenance,
  resolveScopedSlackIdentity,
  resolveSlackInstanceAliases,
  SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
  SLACK_IDENTITY_NOT_FOUND_REASON,
  SLACK_IDENTITY_RESOLVED_REASON,
  SlackInstanceIdentityProvenanceSchema,
} from "./instance-alias.js";

const SLUG = "ravi-rbbt-slack";
const UUID = "0bc9635c-1ee9-42e3-9112-95be9cdb0334";
const OTHER_SLUG = "hana-slack";
const OTHER_UUID = "11111111-2222-3333-4444-555555555555";

function instance(name: string, instanceId?: string): InstanceConfig {
  return {
    name,
    instanceId,
    channel: "slack",
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "pending",
    createdAt: 1,
    updatedAt: 1,
  };
}

function config(): Pick<RouterConfig, "instances" | "instanceToAccount"> {
  return {
    instances: {
      [SLUG]: instance(SLUG, UUID),
      [OTHER_SLUG]: instance(OTHER_SLUG, OTHER_UUID),
    },
    instanceToAccount: {
      [UUID]: SLUG,
      [OTHER_UUID]: OTHER_SLUG,
    },
  };
}

interface FakeIdentity {
  owner: string | null;
  instanceId: string;
}

function lookupFrom(rows: Record<string, FakeIdentity>): (instanceId: string) => FakeIdentity | null {
  return (instanceId) => rows[instanceId] ?? null;
}

const ownerKeyOf = (identity: FakeIdentity): string | null => identity.owner;

describe("resolveSlackInstanceAliases", () => {
  it("derives canonical UUID and aliases from a received slug", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    expect(aliases.canonical).toBe(UUID);
    expect(aliases.configured).toBe(true);
    expect(aliases.scopedAliases).toEqual([UUID, SLUG]);
    expect(aliases.scopedAliases).not.toContain("");
  });

  it("derives canonical UUID and aliases from a received UUID", () => {
    const aliases = resolveSlackInstanceAliases(config(), UUID);
    expect(aliases.canonical).toBe(UUID);
    expect(aliases.configured).toBe(true);
    expect(aliases.scopedAliases).toEqual([UUID, SLUG]);
  });

  it("keeps the received value canonical when configuration has no mapping", () => {
    const aliases = resolveSlackInstanceAliases({ instances: {}, instanceToAccount: {} }, "slack-instance-1");
    expect(aliases.canonical).toBe("slack-instance-1");
    expect(aliases.configured).toBe(false);
    expect(aliases.scopedAliases).toEqual(["slack-instance-1"]);
  });

  it("uses the slug as canonical when the configured instance has no UUID", () => {
    const cfg: Pick<RouterConfig, "instances" | "instanceToAccount"> = {
      instances: { [SLUG]: instance(SLUG) },
      instanceToAccount: {},
    };
    const aliases = resolveSlackInstanceAliases(cfg, SLUG);
    expect(aliases.canonical).toBe(SLUG);
    expect(aliases.configured).toBe(false);
    expect(aliases.scopedAliases).toEqual([SLUG]);
  });

  it("never treats empty instance references as a scoped alias", () => {
    const aliases = resolveSlackInstanceAliases(config(), "");
    expect(aliases.received).toBe("");
    expect(aliases.canonical).toBe("");
    expect(aliases.scopedAliases).toEqual([]);
  });
});

describe("resolveScopedSlackIdentity", () => {
  it("resolves an identity stored under the UUID when the inbound alias is the slug", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const result = resolveScopedSlackIdentity(
      aliases,
      lookupFrom({ [UUID]: { owner: "contact:luis", instanceId: UUID } }),
      ownerKeyOf,
    );
    expect(result.reason).toBe(SLACK_IDENTITY_RESOLVED_REASON);
    expect(result.matchedInstance).toBe(UUID);
    expect(result.identity?.owner).toBe("contact:luis");
  });

  it("resolves an identity stored under the slug when the inbound alias is the UUID", () => {
    const aliases = resolveSlackInstanceAliases(config(), UUID);
    const result = resolveScopedSlackIdentity(
      aliases,
      lookupFrom({ [SLUG]: { owner: "contact:luis", instanceId: SLUG } }),
      ownerKeyOf,
    );
    expect(result.reason).toBe(SLACK_IDENTITY_RESOLVED_REASON);
    expect(result.matchedInstance).toBe(SLUG);
    expect(result.identity?.owner).toBe("contact:luis");
  });

  it("prefers the canonical scope before any alias", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const result = resolveScopedSlackIdentity(
      aliases,
      lookupFrom({
        [UUID]: { owner: "contact:luis", instanceId: UUID },
        [SLUG]: { owner: "contact:luis", instanceId: SLUG },
      }),
      ownerKeyOf,
    );
    expect(result.matchedInstance).toBe(UUID);
  });

  it("never selects the same platform user id from another workspace", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const result = resolveScopedSlackIdentity(
      aliases,
      lookupFrom({ [OTHER_UUID]: { owner: "contact:someone-else", instanceId: OTHER_UUID } }),
      ownerKeyOf,
    );
    expect(result.reason).toBe(SLACK_IDENTITY_NOT_FOUND_REASON);
    expect(result.identity).toBeNull();
  });

  it("fails closed when equivalent aliases resolve to different owners", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const result = resolveScopedSlackIdentity(
      aliases,
      lookupFrom({
        [UUID]: { owner: "contact:luis", instanceId: UUID },
        [SLUG]: { owner: "agent:ravi", instanceId: SLUG },
      }),
      ownerKeyOf,
    );
    expect(result.reason).toBe(SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON);
    expect(result.identity).toBeNull();
    expect(result.matchedInstance).toBeNull();
  });

  it("falls back to the exact empty legacy scope only after scoped misses", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const lookup = lookupFrom({ "": { owner: "contact:luis", instanceId: "" } });
    const result = resolveScopedSlackIdentity(aliases, lookup, ownerKeyOf);
    expect(result.reason).toBe(SLACK_IDENTITY_RESOLVED_REASON);
    expect(result.matchedInstance).toBe("");
  });

  it("does not use the empty legacy scope when a scoped alias already matches", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const result = resolveScopedSlackIdentity(
      aliases,
      lookupFrom({
        [UUID]: { owner: "contact:luis", instanceId: UUID },
        "": { owner: "contact:legacy", instanceId: "" },
      }),
      ownerKeyOf,
    );
    expect(result.matchedInstance).toBe(UUID);
    expect(result.identity?.owner).toBe("contact:luis");
  });

  it("does not treat the empty legacy scope as a wildcard for other workspaces", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const result = resolveScopedSlackIdentity(
      aliases,
      lookupFrom({ [OTHER_UUID]: { owner: "contact:other", instanceId: OTHER_UUID } }),
      ownerKeyOf,
    );
    expect(result.reason).toBe(SLACK_IDENTITY_NOT_FOUND_REASON);
  });

  it("reports identity_not_found when nothing resolves", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const result = resolveScopedSlackIdentity(aliases, lookupFrom({}), ownerKeyOf);
    expect(result.reason).toBe(SLACK_IDENTITY_NOT_FOUND_REASON);
    expect(result.identity).toBeNull();
  });
});

describe("buildSlackInstanceProvenance", () => {
  it("emits concrete, schema-valid provenance for a resolved identity", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const provenance = buildSlackInstanceProvenance(aliases, {
      reason: SLACK_IDENTITY_RESOLVED_REASON,
      matchedInstance: UUID,
    });
    expect(SlackInstanceIdentityProvenanceSchema.parse(provenance)).toEqual(provenance);
    expect(provenance).toEqual({
      source: "platform_identities",
      channel: "slack",
      receivedInstance: SLUG,
      canonicalInstance: UUID,
      matchedInstance: UUID,
      reason: SLACK_IDENTITY_RESOLVED_REASON,
    });
  });

  it("emits ambiguous provenance without leaking a matched instance", () => {
    const aliases = resolveSlackInstanceAliases(config(), SLUG);
    const provenance = buildSlackInstanceProvenance(aliases, {
      reason: SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
      matchedInstance: null,
    });
    expect(provenance.reason).toBe(SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON);
    expect(provenance.matchedInstance).toBeNull();
  });
});
