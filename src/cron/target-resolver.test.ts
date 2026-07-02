import { describe, expect, it } from "bun:test";
import { resolveCronTarget, type CronTargetResolverDeps } from "./target-resolver.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "cron-1",
    name: "Test Job",
    enabled: true,
    deleteAfterRun: false,
    schedule: { type: "every", every: 1_800_000 },
    sessionTarget: "main",
    executionType: "agent",
    message: "hello",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CronTargetResolverDeps> = {}): CronTargetResolverDeps {
  return {
    getAgent: () => ({ id: "main" }),
    getDefaultAgentId: () => "main",
    resolveSession: () => null,
    deriveSourceFromSessionKey: () => null,
    ...overrides,
  };
}

describe("resolveCronTarget", () => {
  describe("agent jobs", () => {
    it("returns ok when agent exists and no reply session", () => {
      const result = resolveCronTarget(makeJob(), makeDeps());
      expect(result.state).toBe("ok");
      expect(result.agentExists).toBe(true);
      expect(result.replySessionLive).toBeNull();
    });

    it("returns agent_missing when agent does not exist", () => {
      const result = resolveCronTarget(makeJob({ agentId: "ghost" }), makeDeps({ getAgent: () => null }));
      expect(result.state).toBe("agent_missing");
      expect(result.agentExists).toBe(false);
      expect(result.detail).toContain("ghost");
    });

    it("returns agent_missing when default agent does not exist", () => {
      const result = resolveCronTarget(
        makeJob({ agentId: undefined }),
        makeDeps({ getAgent: () => null, getDefaultAgentId: () => "missing-default" }),
      );
      expect(result.state).toBe("agent_missing");
      expect(result.detail).toContain("missing-default");
    });

    it("returns ok when reply session resolves", () => {
      const result = resolveCronTarget(
        makeJob({ replySession: "agent:main:whatsapp:main:group:123" }),
        makeDeps({
          resolveSession: () => ({ name: "sales-group" }),
        }),
      );
      expect(result.state).toBe("ok");
      expect(result.agentExists).toBe(true);
      expect(result.replySessionLive).toBe(true);
      expect(result.routingKind).toBe("resolved-session");
    });

    it("returns derived_key when reply session falls back to key-derived routing", () => {
      const result = resolveCronTarget(
        makeJob({ replySession: "agent:main:whatsapp:main:group:123" }),
        makeDeps({
          resolveSession: () => null,
          deriveSourceFromSessionKey: () => ({
            channel: "whatsapp",
            accountId: "main",
            chatId: "group:123",
          }),
        }),
      );
      expect(result.state).toBe("derived_key");
      expect(result.agentExists).toBe(true);
      expect(result.replySessionLive).toBe(false);
      expect(result.routingKind).toBe("derived-key");
    });

    it("returns reply_session_missing when session does not resolve and key cannot derive", () => {
      const result = resolveCronTarget(
        makeJob({ replySession: "agent:main:main" }),
        makeDeps({
          resolveSession: () => null,
          deriveSourceFromSessionKey: () => null,
        }),
      );
      expect(result.state).toBe("reply_session_missing");
      expect(result.agentExists).toBe(true);
      expect(result.replySessionLive).toBe(false);
    });
  });

  describe("shell jobs", () => {
    it("returns ok for shell job without notification target", () => {
      const result = resolveCronTarget(
        makeJob({ executionType: "shell", shellCommand: "echo ok", message: "" }),
        makeDeps(),
      );
      expect(result.state).toBe("ok");
      expect(result.agentExists).toBeNull();
      expect(result.replySessionLive).toBeNull();
    });

    it("does not mark shell job as agent_missing", () => {
      const result = resolveCronTarget(
        makeJob({ executionType: "shell", shellCommand: "echo ok", message: "", agentId: "ghost" }),
        makeDeps({ getAgent: () => null }),
      );
      expect(result.state).toBe("ok");
      expect(result.agentExists).toBeNull();
    });

    it("returns ok for shell job with resolvable onError target", () => {
      const result = resolveCronTarget(
        makeJob({
          executionType: "shell",
          shellCommand: "echo ok",
          message: "",
          onError: "notify-session:ops-channel",
        }),
        makeDeps({
          resolveSession: () => ({ name: "ops-channel" }),
        }),
      );
      expect(result.state).toBe("ok");
      expect(result.replySessionLive).toBe(true);
    });

    it("returns derived_key for shell job with key-derived onError target", () => {
      const result = resolveCronTarget(
        makeJob({
          executionType: "shell",
          shellCommand: "echo ok",
          message: "",
          onError: "notify-session:agent:main:whatsapp:main:group:123",
        }),
        makeDeps({
          resolveSession: () => null,
          deriveSourceFromSessionKey: () => ({
            channel: "whatsapp",
            accountId: "main",
            chatId: "group:123",
          }),
        }),
      );
      expect(result.state).toBe("derived_key");
      expect(result.detail).toContain("onError");
    });

    it("returns reply_session_missing for shell job with unresolvable onError target", () => {
      const result = resolveCronTarget(
        makeJob({
          executionType: "shell",
          shellCommand: "echo ok",
          message: "",
          onError: "notify-session:agent:main:main",
        }),
        makeDeps({
          resolveSession: () => null,
          deriveSourceFromSessionKey: () => null,
        }),
      );
      expect(result.state).toBe("reply_session_missing");
      expect(result.detail).toContain("onError");
    });
  });
});
