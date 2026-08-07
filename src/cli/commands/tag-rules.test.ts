import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { addContactTag, closeContacts, getContact, upsertContact } from "../../contacts.js";
import type { TagRule } from "../../tag-rules/index.js";
import { ContractError } from "../agent-contract.js";
import { TagRulesCommands } from "./tag-rules.js";

let stateDir: string | null = null;
let previousSessionKey: string | undefined;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("tag-rules-cli-");
  // hasContext() true → the contract helpers (and fail()) throw instead of
  // calling process.exit, so tests can assert the ContractError envelope.
  previousSessionKey = process.env.RAVI_SESSION_KEY;
  process.env.RAVI_SESSION_KEY = "agent:test:main";
});

afterEach(async () => {
  if (previousSessionKey === undefined) delete process.env.RAVI_SESSION_KEY;
  else process.env.RAVI_SESSION_KEY = previousSessionKey;
  previousSessionKey = undefined;
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function writeRule(rule: TagRule, name: string = `${rule.id}.json`): void {
  if (!stateDir) throw new Error("missing state dir");
  const dir = join(stateDir, "tag-rules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(rule), "utf8");
}

/** Rule that would move lifecycle:new → lifecycle:qualified on any matching contact. */
function qualifyRule(id = "qualify-buy-intent"): TagRule {
  return {
    id,
    scope: "contact",
    enabled: true,
    priority: 0,
    conditions: [{ kind: "has-tag", tag: "lifecycle:new" }],
    apply: [
      {
        target: "contact",
        tag: "lifecycle:qualified",
        removeTag: "lifecycle:new",
        when: "matched",
      },
    ],
    evaluation: { reactive: true, cron: null },
  } as TagRule;
}

function withoutLogs<T>(run: () => T): T {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return run();
  } finally {
    console.log = originalLog;
  }
}

async function withoutLogsAsync<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
  }
}

function expectContractError(run: () => unknown): InstanceType<typeof ContractError> {
  let thrown: unknown;
  try {
    withoutLogs(run);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  return thrown as InstanceType<typeof ContractError>;
}

describe("tag-rules agent-first contract", () => {
  it("emits TAG_RULE_NOT_FOUND envelope with suggestions on tag-rules show --json (exit 1)", () => {
    writeRule(qualifyRule("qualify-buy-intent"));
    writeRule(qualifyRule("cold-lead"));
    const commands = new TagRulesCommands();
    const contractError = expectContractError(() => commands.show("qualify-buy-inten", true));
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("tag-rules show");
    expect(envelope.error.code).toBe("TAG_RULE_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("qualify-buy-intent");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("emits TAG_RULE_NOT_FOUND on tag-rules evaluate for an unknown registry rule (exit 1)", () => {
    writeRule(qualifyRule("qualify-buy-intent"));
    const commands = new TagRulesCommands();
    const contractError = expectContractError(() =>
      commands.evaluate("ghost-rule", "contact:whatever", undefined, undefined, true),
    );
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("tag-rules evaluate");
    expect(envelope.error.code).toBe("TAG_RULE_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("qualify-buy-intent");
  });

  it("maps the engine throw on an unknown target to CONTACT_NOT_FOUND without suggestions (exit 1)", () => {
    writeRule(qualifyRule());
    const commands = new TagRulesCommands();
    const contractError = expectContractError(() =>
      commands.evaluate("qualify-buy-intent", "contact:ghost-contact", undefined, undefined, true),
    );
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("tag-rules evaluate");
    expect(envelope.error.code).toBe("CONTACT_NOT_FOUND");
    // Contact visibility is scoped inside the contacts domain; no suggestions here.
    expect(envelope.error.suggestions).toBeUndefined();
  });

  it("supports --fields compact mode on tag-rules list", () => {
    writeRule(qualifyRule("qualify-buy-intent"));
    writeRule(qualifyRule("cold-lead"));
    const commands = new TagRulesCommands();
    const payload = withoutLogs(() => commands.list(true, undefined, undefined, "id,scope")) as {
      rules: Array<Record<string, unknown>>;
    };
    expect(payload.rules).toHaveLength(2);
    for (const rule of payload.rules) {
      expect(Object.keys(rule).sort()).toEqual(["id", "scope"]);
    }
  });

  it("emits TAG_RULE_VALIDATION_FAILED with file names but no absolute paths", () => {
    if (!stateDir) throw new Error("missing state dir");
    const rulesDir = join(stateDir, "tag-rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "broken.json"), "{", "utf8");

    const contractError = expectContractError(() => new TagRulesCommands().validate(true));
    expect(contractError.code).toBe("TAG_RULE_VALIDATION_FAILED");
    expect(contractError.exitCode).toBe(1);
    expect(contractError.details.errors).toEqual([
      { source: "broken.json", code: "INVALID_JSON", message: "Rule file is not valid JSON" },
    ]);
    expect(JSON.stringify(contractError.envelope())).not.toContain(stateDir);
  });

  it("tag-rules tick WITHOUT --apply reports the would-apply plan but writes no tags", async () => {
    upsertContact("5511990001111", "Tick Dry", "allowed", "manual");
    addContactTag("5511990001111", "lifecycle:new");
    writeRule(qualifyRule());

    const commands = new TagRulesCommands();
    const result = (await withoutLogsAsync(() => commands.tick(undefined, undefined, true))) as {
      contactsProcessed: number;
      matched: number;
    };
    expect(result.contactsProcessed).toBeGreaterThanOrEqual(1);
    expect(result.matched).toBeGreaterThanOrEqual(1);

    // The DB is the spy: dry-run must leave the contact tags untouched.
    const refreshed = getContact("5511990001111")!;
    expect(refreshed.tags).toContain("lifecycle:new");
    expect(refreshed.tags).not.toContain("lifecycle:qualified");
  });

  it("tag-rules evaluate WITHOUT --apply writes nothing; --apply performs the same write (equivalent brake)", () => {
    upsertContact("5511990002222", "Evaluate Dry", "allowed", "manual");
    addContactTag("5511990002222", "lifecycle:new");
    writeRule(qualifyRule());
    const contactId = getContact("5511990002222")!.id;
    const commands = new TagRulesCommands();

    const dryRun = withoutLogs(() =>
      commands.evaluate("qualify-buy-intent", `contact:${contactId}`, undefined, undefined, true),
    ) as { apply: boolean };
    expect(dryRun.apply).toBe(false);
    const untouched = getContact("5511990002222")!;
    expect(untouched.tags).toContain("lifecycle:new");
    expect(untouched.tags).not.toContain("lifecycle:qualified");

    const applied = withoutLogs(() =>
      commands.evaluate("qualify-buy-intent", `contact:${contactId}`, true, undefined, true),
    ) as { apply: boolean };
    expect(applied.apply).toBe(true);
    const refreshed = getContact("5511990002222")!;
    expect(refreshed.tags).toContain("lifecycle:qualified");
    expect(refreshed.tags).not.toContain("lifecycle:new");
  });
});
