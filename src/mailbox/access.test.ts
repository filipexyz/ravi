import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { grantRelation } from "../permissions/relations.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { canUseMailMailbox, canUseMailProvider, getMailScopeContext } from "./access.js";
import { createMailAccount, createMailMailbox } from "./index.js";

let stateDir: string | null = null;
let previousAgentId: string | undefined;

describe("mailbox REBAC access", () => {
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

    grantRelation("agent", "mail-agent", "read", "mailbox", mailbox.normalizedAddress, "test");
    expect(canUseMailMailbox(getMailScopeContext(), "read", mailbox)).toBe(true);
    expect(canUseMailMailbox(getMailScopeContext(), "send", mailbox)).toBe(false);

    grantRelation("agent", "mail-agent", "send", "mailbox", "*", "test");
    expect(canUseMailMailbox(getMailScopeContext(), "send", mailbox)).toBe(true);
  });

  it("requires provider-scoped grants for provider sync", () => {
    process.env.RAVI_AGENT_ID = "mail-agent";

    expect(canUseMailProvider(getMailScopeContext(), "sync", "ravi-mail")).toBe(false);

    grantRelation("agent", "mail-agent", "sync", "mail-provider", "ravi-mail", "test");
    expect(canUseMailProvider(getMailScopeContext(), "sync", "ravi-mail")).toBe(true);
    expect(canUseMailProvider(getMailScopeContext(), "manage", "ravi-mail")).toBe(false);
  });
});
