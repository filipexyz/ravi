import { describe, expect, it } from "bun:test";
import {
  DEFAULT_KNOWLEDGE_DIGEST_TIME,
  isValidHostname,
  knowledgeSettings,
  validateContactMemoryAgents,
  validateDigestTime,
  validateEgressAllow,
  validateOwnerTarget,
} from "./settings.js";

const validatorDeps = {
  agentExists: (id: string) => id === "main" || id === "sales",
  instanceChannel: (name: string) => (name === "wa-main" ? "whatsapp" : name === "slack-main" ? "slack" : null),
};

function settings(values: Record<string, string>) {
  return knowledgeSettings({ getSetting: (key) => values[key] ?? null });
}

describe("knowledgeSettings", () => {
  it("reads defaults when nothing is set", () => {
    const s = settings({});
    expect(s.contactMemoryAgents).toEqual([]);
    expect(s.project).toBeNull();
    expect(s.curatorAgent).toBeNull();
    expect(s.digestTime).toBe(DEFAULT_KNOWLEDGE_DIGEST_TIME);
    expect(s.digestTimezone.length).toBeGreaterThan(0);
    expect(s.ownerTarget).toBeNull();
    expect(s.egressAllow("wa-main")).toBeNull();
  });

  it("parses the csv and reads the egress map back per instance", () => {
    const s = settings({
      "knowledge.contactMemory.agents": " main, sales ,main",
      "knowledge.digest.time": "07:30",
      "knowledge.digest.timezone": "America/Sao_Paulo",
      "knowledge.egress.allow": '{"wa-main":["Example.com","docs.acme.io"]}',
    });
    expect(s.contactMemoryAgents).toEqual(["main", "sales"]);
    expect(s.digestTime).toBe("07:30");
    expect(s.digestTimezone).toBe("America/Sao_Paulo");
    expect(s.egressAllow("wa-main")).toEqual(["example.com", "docs.acme.io"]);
    expect(s.egressAllow("slack-main")).toBeNull();
  });

  it("fails closed on an egress value that no longer parses, and ignores a bad digest time", () => {
    const s = settings({ "knowledge.egress.allow": "{nope", "knowledge.digest.time": "25:00" });
    expect(s.egressAllow("wa-main")).toEqual([]);
    expect(s.digestTime).toBe(DEFAULT_KNOWLEDGE_DIGEST_TIME);
  });
});

describe("validators", () => {
  it("refuse bad digest times and owner targets", () => {
    for (const bad of ["8:00", "24:00", "08:60", "0800", "morning"]) {
      expect(() => validateDigestTime(bad)).toThrow();
    }
    validateDigestTime("08:00");
    validateDigestTime("23:59");
    for (const bad of [
      "whatsapp:wa-main",
      "whatsapp::551199",
      ":wa-main:551199",
      "slack:wa-main:U1",
      "whatsapp:nope:551199",
    ]) {
      expect(() => validateOwnerTarget(bad, validatorDeps)).toThrow();
    }
    validateOwnerTarget("whatsapp:wa-main:5511999999999", validatorDeps);
  });

  it("refuse unknown agents in the csv", () => {
    expect(() => validateContactMemoryAgents("main,ghost", validatorDeps)).toThrow(/ghost/);
    expect(() => validateContactMemoryAgents("main,,sales", validatorDeps)).toThrow();
    validateContactMemoryAgents("main, sales", validatorDeps);
  });

  it("knowledge.egress.allow: object of hostname arrays keyed by existing instances", () => {
    expect(() => validateEgressAllow('["example.com"]', validatorDeps)).toThrow(/JSON object/);
    expect(() => validateEgressAllow("null", validatorDeps)).toThrow(/JSON object/);
    expect(() => validateEgressAllow("not json", validatorDeps)).toThrow(/JSON object/);
    expect(() => validateEgressAllow('{"wa-main":"example.com"}', validatorDeps)).toThrow(/array/);
    expect(() => validateEgressAllow('{"wa-main":["exa mple.com"]}', validatorDeps)).toThrow(/hostname/);
    expect(() => validateEgressAllow('{"wa-main":["https://example.com"]}', validatorDeps)).toThrow(/hostname/);
    expect(() => validateEgressAllow('{"wa-main":[42]}', validatorDeps)).toThrow(/hostname/);
    expect(() => validateEgressAllow('{"ghost":["example.com"]}', validatorDeps)).toThrow(/ghost/);
    validateEgressAllow('{"wa-main":["example.com","docs.acme.io"],"slack-main":[]}', validatorDeps);
    expect(isValidHostname("localhost")).toBe(false);
    expect(isValidHostname("10.0.0.1")).toBe(false);
    expect(isValidHostname("-bad.com")).toBe(false);
  });
});
