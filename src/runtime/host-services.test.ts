import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { UNCONDITIONAL_BLOCKS } from "../bash/index.js";
import { listPermissionDenials, setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import type { ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getOrCreateSession } from "../router/index.js";
import { createRuntimeContext } from "./context-registry.js";
import { createRuntimeHostServices } from "./host-services.js";

let stateDir: string | null = null;
let auditEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let previousAuditSuppression: string | undefined;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-host-services-test-");
  // Observe emitted audit events instead of suppressing them for this suite.
  previousAuditSuppression = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  auditEvents = [];
  setPermissionAuditPublisherForTest((topic, data) => {
    auditEvents.push({ topic, data });
  });
});

afterEach(async () => {
  setPermissionAuditPublisherForTest();
  if (previousAuditSuppression === undefined) {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  } else {
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousAuditSuppression;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const WILDCARD_EXECUTABLE: ContextCapability[] = [
  { permission: "use", objectType: "tool", objectId: "Bash", source: "test" },
  { permission: "execute", objectType: "executable", objectId: "*", source: "test" },
];

const ADMIN_SYSTEM: ContextCapability[] = [
  { permission: "admin", objectType: "system", objectId: "*", source: "test" },
];

function makeServices(capabilities: ContextCapability[]) {
  getOrCreateSession("agent:main:main", "main", stateDir!, {
    name: "host-services-test",
    runtimeProvider: "codex",
    providerSessionId: "thread-1",
    runtimeSessionDisplayId: "thread-1",
  });
  const context = createRuntimeContext({
    kind: "agent-runtime",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionName: "host-services-test",
    capabilities,
  });
  return createRuntimeHostServices({
    context,
    agentId: "main",
    sessionName: "host-services-test",
    toolContext: {},
  });
}

const authorities: Array<{ label: string; capabilities: ContextCapability[] }> = [
  { label: "wildcard executable grant", capabilities: WILDCARD_EXECUTABLE },
  { label: "admin system:*", capabilities: ADMIN_SYSTEM },
];

describe("runtime host services shell hard-safety", () => {
  for (const authority of authorities) {
    for (const executable of UNCONDITIONAL_BLOCKS) {
      it(`denies unconditional '${executable}' under ${authority.label}`, async () => {
        const services = makeServices(authority.capabilities);
        const decision = await services.authorizeCommandExecution({
          command: `${executable} -c 'echo hi'`,
          input: {},
        });

        expect(decision.approved).toBe(false);
        expect(decision.reason).toContain(executable);

        const denied = auditEvents.find((event) => event.topic === "ravi.audit.denied");
        expect(denied?.data.blockType).toBe("runtime_executable_unconditional_block");
        // Hard-safety denials are policy decisions and never persist a resolvable row.
        expect(listPermissionDenials({ subjectType: "agent", subjectId: "main", resolved: false })).toEqual([]);
      });
    }

    it(`denies dangerous patterns under ${authority.label}`, async () => {
      const services = makeServices(authority.capabilities);
      const decision = await services.authorizeCommandExecution({
        command: "echo $(whoami)",
        input: {},
      });

      expect(decision.approved).toBe(false);
      const denied = auditEvents.find((event) => event.topic === "ravi.audit.denied");
      expect(denied?.data.blockType).toBe("runtime_command_dangerous_pattern");
      expect(listPermissionDenials({ subjectType: "agent", subjectId: "main", resolved: false })).toEqual([]);
    });

    it(`allows 'git status' under ${authority.label}`, async () => {
      const services = makeServices(authority.capabilities);
      const decision = await services.authorizeCommandExecution({
        command: "git status",
        input: {},
      });

      expect(decision.approved).toBe(true);
    });

    it(`allows 'ls -la' under ${authority.label}`, async () => {
      const services = makeServices(authority.capabilities);
      const decision = await services.authorizeCommandExecution({
        command: "ls -la",
        input: {},
      });

      expect(decision.approved).toBe(true);
    });
  }

  it("emits bounded, provenance-bearing audit without leaking a context key", async () => {
    const services = makeServices(ADMIN_SYSTEM);
    await services.authorizeCommandExecution({
      command: `bash -c '${"x".repeat(500)}'`,
      input: {},
    });

    const denied = auditEvents.find((event) => event.topic === "ravi.audit.denied");
    expect(denied).toBeDefined();
    const data = denied!.data;
    expect(data.blockType).toBe("runtime_executable_unconditional_block");
    // Command payload stays bounded.
    expect(typeof data.command).toBe("string");
    expect((data.command as string).length).toBeLessThanOrEqual(200);
    // Provenance is present and carries the agent, not the opaque context key.
    const provenance = data.context as Record<string, unknown> | undefined;
    expect(provenance?.agentId).toBe("main");
    expect(JSON.stringify(data)).not.toContain("rctx_");
  });
});
