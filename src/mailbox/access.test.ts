import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext } from "../cli/context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { canUseMailMailbox, canUseMailProvider, getMailScopeContext } from "./access.js";
import { createMailAccount, createMailMailbox } from "./index.js";

let stateDir: string | null = null;
let previousAgentId: string | undefined;

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId };
}

function toolContext(capabilities: ContextCapability[]): { agentId: string; context: ContextRecord } {
  return {
    agentId: "mail-agent",
    context: {
      contextId: "ctx_mailbox_access",
      contextKey: "ctx_key_mailbox_access",
      kind: "test-runtime",
      agentId: "mail-agent",
      capabilities,
      metadata: {},
      createdAt: 0,
    },
  };
}

describe("mailbox Permission Provider Runtime access", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-mailbox-access-test-");
    previousAgentId = process.env.RAVI_AGENT_ID;
    delete process.env.RAVI_AGENT_ID;
  });

  afterEach(async () => {
    if (previousAgentId === undefined) {
      delete process.env.RAVI_AGENT_ID;
    } else {
      process.env.RAVI_AGENT_ID = previousAgentId;
    }
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("allows direct CLI but requires explicit mailbox grants for agents", () => {
    const account = createMailAccount({ provider: "ravi-mail" });
    const mailbox = createMailMailbox({ accountId: account.id, address: "Luis@Ravi.Bot", isDefault: true });

    expect(canUseMailMailbox(getMailScopeContext(), "read", mailbox)).toBe(true);

    process.env.RAVI_AGENT_ID = "mail-agent";
    expect(canUseMailMailbox(getMailScopeContext(), "read", mailbox)).toBe(false);

    runWithContext(toolContext([cap("read", "mailbox", mailbox.normalizedAddress)]), () => {
      expect(canUseMailMailbox(getMailScopeContext(), "read", mailbox)).toBe(true);
      expect(canUseMailMailbox(getMailScopeContext(), "send", mailbox)).toBe(false);
    });

    runWithContext(toolContext([cap("send", "mailbox", "*")]), () => {
      expect(canUseMailMailbox(getMailScopeContext(), "send", mailbox)).toBe(true);
    });
  });

  it("requires provider-scoped grants for provider sync", () => {
    process.env.RAVI_AGENT_ID = "mail-agent";

    expect(canUseMailProvider(getMailScopeContext(), "sync", "ravi-mail")).toBe(false);

    runWithContext(toolContext([cap("sync", "mail-provider", "ravi-mail")]), () => {
      expect(canUseMailProvider(getMailScopeContext(), "sync", "ravi-mail")).toBe(true);
      expect(canUseMailProvider(getMailScopeContext(), "manage", "ravi-mail")).toBe(false);
    });
  });
});
