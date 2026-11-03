// An in-memory `CloudAgentProvider` for tests: it records every call, lets a
// test script session events, statuses and usage, and fails on demand.

import {
  type CloudAgentProvider,
  type CloudProviderFactory,
  CloudProviderError,
  type ProviderAgentSpec,
  type ProviderEnvironmentSpec,
  type ProviderEvent,
  type ProviderMcpCredential,
  type ProviderOutput,
  type ProviderRepositoryResource,
  type ProviderSessionStatus,
  type ProviderUsage,
} from "./types";

export type FakeSession = {
  id: string;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  vaultIds: string[];
  budgetCents: number;
  resources: ProviderRepositoryResource[];
  title: string;
  metadata: Record<string, string>;
  status: ProviderSessionStatus;
  usage: ProviderUsage;
  events: ProviderEvent[];
  sent: { type: "message" | "confirmation" | "interrupt"; text?: string; toolUseId?: string; allow?: boolean; message?: string }[];
  outputs: (ProviderOutput & { content: string })[];
  deleted: boolean;
};

export class FakeCloudProviderState {
  readonly calls: { method: keyof CloudAgentProvider; apiKey: string; args: unknown[] }[] = [];
  readonly agents = new Map<string, { spec: ProviderAgentSpec; version: number }>();
  readonly environments = new Map<string, ProviderEnvironmentSpec>();
  readonly skills = new Map<string, { versions: string[]; files: { path: string; content: string }[] }>();
  readonly vaults = new Map<string, { credentials: Map<string, ProviderMcpCredential>; deleted: boolean }>();
  readonly sessions = new Map<string, FakeSession>();
  /** Keys `verifyKey` and every other call reject with `auth`. */
  readonly rejectedKeys = new Set<string>();
  private readonly failures = new Map<string, CloudProviderError[]>();
  private counter = 0;
  private clock = Date.parse("2026-10-19T12:00:00Z");

  nextId(prefix: string) {
    this.counter += 1;
    return `${prefix}_fake${String(this.counter).padStart(4, "0")}`;
  }

  /** The next call of `method` throws `error` (queued, one per call). */
  failNext(method: keyof CloudAgentProvider, error = new CloudProviderError("unavailable", `fake ${String(method)} failure`, 503)) {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
  }

  takeFailure(method: keyof CloudAgentProvider) {
    return this.failures.get(method)?.shift() ?? null;
  }

  session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`fake session ${id} not found`);
    return session;
  }

  onlySession() {
    const sessions = [...this.sessions.values()];
    if (sessions.length !== 1) throw new Error(`expected one fake session, found ${sessions.length}`);
    return sessions[0]!;
  }

  /** Appends events (ids and times filled in) and moves the session's status with them. */
  emit(sessionId: string, events: DistributiveOmit<ProviderEvent, "id" | "at">[]) {
    const session = this.session(sessionId);
    for (const event of events) {
      this.clock += 1000;
      const full = { ...event, id: this.nextId("sevt"), at: new Date(this.clock) } as ProviderEvent;
      session.events.push(full);
      if (full.kind === "status") session.status = full.status;
    }
    return session.events.slice(-events.length);
  }

  setUsage(sessionId: string, usage: Partial<ProviderUsage>) {
    const session = this.session(sessionId);
    session.usage = { ...session.usage, ...usage };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function fakeCloudProviderFactory(state: FakeCloudProviderState): CloudProviderFactory {
  return ({ apiKey }) => fakeCloudProvider(state, apiKey);
}

export function fakeCloudProvider(state: FakeCloudProviderState, apiKey: string): CloudAgentProvider {
  const record = async <T>(method: keyof CloudAgentProvider, args: unknown[], run: () => T): Promise<T> => {
    state.calls.push({ method, apiKey, args });
    if (state.rejectedKeys.has(apiKey)) throw new CloudProviderError("auth", "invalid x-api-key", 401);
    const failure = state.takeFailure(method);
    if (failure) throw failure;
    return run();
  };
  const live = (sessionId: string) => {
    const session = state.sessions.get(sessionId);
    if (!session || session.deleted) throw new CloudProviderError("not_found", "session not found", 404);
    return session;
  };

  return {
    name: "anthropic",
    verifyKey: () => record("verifyKey", [], () => undefined),
    ensureSkill: (input) =>
      record("ensureSkill", [input], () => {
        const version = state.nextId("skillver");
        const existing = input.existingSkillId ? state.skills.get(input.existingSkillId) : undefined;
        if (existing && input.existingSkillId) {
          existing.versions.push(version);
          existing.files = [...input.files];
          return { skillId: input.existingSkillId, version };
        }
        const skillId = state.nextId("skill");
        state.skills.set(skillId, { versions: [version], files: [...input.files] });
        return { skillId, version };
      }),
    upsertAgent: (spec, existing) =>
      record("upsertAgent", [spec, existing], () => {
        if (existing) {
          const current = state.agents.get(existing.agentId);
          if (!current) throw new CloudProviderError("not_found", "agent not found", 404);
          const version = current.version + 1;
          state.agents.set(existing.agentId, { spec, version });
          return { agentId: existing.agentId, version };
        }
        const agentId = state.nextId("agent");
        state.agents.set(agentId, { spec, version: 1 });
        return { agentId, version: 1 };
      }),
    ensureEnvironment: (spec, existingId) =>
      record("ensureEnvironment", [spec, existingId], () => {
        const environmentId = existingId ?? state.nextId("env");
        state.environments.set(environmentId, spec);
        return { environmentId };
      }),
    createVault: (input) =>
      record("createVault", [input], () => {
        const vaultId = state.nextId("vlt");
        state.vaults.set(vaultId, { credentials: new Map(), deleted: false });
        return { vaultId };
      }),
    addMcpCredential: (vaultId, credential) =>
      record("addMcpCredential", [vaultId, credential], () => {
        const vault = state.vaults.get(vaultId);
        if (!vault) throw new CloudProviderError("not_found", "vault not found", 404);
        const credentialId = state.nextId("vcrd");
        vault.credentials.set(credentialId, credential);
        return { credentialId };
      }),
    updateMcpCredential: (vaultId, credentialId, credential) =>
      record("updateMcpCredential", [vaultId, credentialId, credential], () => {
        const vault = state.vaults.get(vaultId);
        if (!vault?.credentials.has(credentialId)) throw new CloudProviderError("not_found", "credential not found", 404);
        vault.credentials.set(credentialId, credential);
      }),
    deleteVault: (vaultId) =>
      record("deleteVault", [vaultId], () => {
        const vault = state.vaults.get(vaultId);
        if (vault) vault.deleted = true;
      }),
    createSession: (input) =>
      record("createSession", [input], () => {
        const id = state.nextId("sesn");
        state.sessions.set(id, {
          id,
          ...input,
          status: "idle",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, listCostCents: 0, activeSeconds: 0 },
          events: [],
          sent: [],
          outputs: [],
          deleted: false,
        });
        return { sessionId: id };
      }),
    sendMessage: (sessionId, text) =>
      record("sendMessage", [sessionId, text], () => {
        const session = live(sessionId);
        session.sent.push({ type: "message", text });
        state.emit(sessionId, [
          { kind: "message", role: "user", text },
          { kind: "status", status: "running", stopReason: null },
        ]);
      }),
    confirmTool: (sessionId, toolUseId, decision) =>
      record("confirmTool", [sessionId, toolUseId, decision], () => {
        const session = live(sessionId);
        session.sent.push({ type: "confirmation", toolUseId, allow: decision.allow, message: decision.message });
        state.emit(sessionId, [{ kind: "status", status: "running", stopReason: null }]);
      }),
    interrupt: (sessionId) =>
      record("interrupt", [sessionId], () => {
        const session = live(sessionId);
        session.sent.push({ type: "interrupt" });
        state.emit(sessionId, [{ kind: "status", status: "idle", stopReason: { type: "end_turn" } }]);
      }),
    getSession: (sessionId) =>
      record("getSession", [sessionId], () => {
        const session = state.sessions.get(sessionId);
        if (!session || session.deleted) return null;
        return { id: session.id, status: session.status, usage: { ...session.usage } };
      }),
    listEvents: (sessionId, cursor, limit) =>
      record("listEvents", [sessionId, cursor, limit], () => {
        const session = live(sessionId);
        const offset = cursor ? Number(cursor) : 0;
        const events = session.events.slice(offset, offset + limit);
        const next = offset + events.length;
        return { events, cursor: String(next), hasMore: next < session.events.length };
      }),
    listOutputs: (sessionId) =>
      record("listOutputs", [sessionId], () => live(sessionId).outputs.map(({ content: _content, ...output }) => output)),
    downloadOutput: (sessionId, outputId) =>
      record("downloadOutput", [sessionId, outputId], () => {
        const output = live(sessionId).outputs.find((candidate) => candidate.id === outputId);
        if (!output) throw new CloudProviderError("not_found", "file not found", 404);
        const bytes = new TextEncoder().encode(output.content);
        return {
          body: new Response(bytes).body,
          contentType: output.mimeType ?? "application/octet-stream",
          name: output.name,
          size: bytes.byteLength,
        };
      }),
    deleteSession: (sessionId) =>
      record("deleteSession", [sessionId], () => {
        const session = state.sessions.get(sessionId);
        if (session) session.deleted = true;
      }),
  };
}
