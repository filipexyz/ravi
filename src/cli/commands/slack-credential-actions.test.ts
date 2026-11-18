import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explainCredentialPolicy, isDestructiveAction } from "../../credentials/broker.js";

/**
 * Every Slack action `ravi slack` sends to the credential broker, classified.
 *
 * - `read`: the broker asks nobody.
 * - `write`: the broker asks for approval, except on the author's own turn
 *   when the author holds the action (see the broker SPEC).
 * - `destructive`: the broker always asks, even on the author's own turn,
 *   either because the action's verb says so (`*.delete`, ...) or because the
 *   command marks the call `destructive: true`.
 *
 * Adding a command that sends a new action, or changing how an existing one
 * is classified, fails this test until the table says what the action is.
 */
type ActionClass = "read" | "write" | "destructive";

const SLACK_CREDENTIAL_ACTIONS: Record<string, ActionClass> = {
  "auth.test": "read",
  "blocks.validate": "read",
  "canvases.sections.lookup": "read",
  "conversations.history": "read",
  "conversations.info": "read",
  "conversations.list": "read",
  "conversations.members": "read",
  "files.list": "read",
  "slack.topology": "read",

  "canvases.access.set": "write",
  "canvases.create": "write",
  // A section delete or a whole-canvas replace is marked destructive by the
  // command (`isSlackCanvasRemovalChange`); other edits are writes.
  "canvases.edit": "write",
  "chat.postEphemeral": "write",
  "chat.postMessage": "write",
  "chat.unfurl": "write",
  "chat.update": "write",
  "conversations.canvases.create": "write",
  "conversations.create": "write",
  "conversations.invite": "write",
  "conversations.rename": "write",
  "entity.presentDetails": "write",
  "slack.interactions.respond": "write",
  "slack.messages.replay": "write",
  "views.open": "write",
  "views.push": "write",
  "views.update": "write",

  "canvases.access.delete": "destructive",
  "canvases.delete": "destructive",
  "slack.canvas.artifact.publish": "destructive",
  "slack.canvas.channelShowcase": "destructive",
  "slack.canvas.showcase": "destructive",
};

/** Calls whose destructive mark depends on the change; everything else must be literal. */
const CONDITIONAL_DESTRUCTIVE_MARKS: Record<string, string> = {
  "canvases.edit": "isSlackCanvasRemovalChange(change)",
};

interface BrokerCall {
  action: string;
  line: number;
  /** Source of the `destructive:` value, when the call sets one. */
  destructive?: string;
}

const source = readFileSync(join(import.meta.dir, "slack.ts"), "utf8");

function lineOf(index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** Literal actions of `const method = cond ? "a" : "b"` declared just before a call. */
function methodLiterals(beforeIndex: number): string[] {
  const window = source.slice(Math.max(0, beforeIndex - 4000), beforeIndex);
  const declarations = [...window.matchAll(/const method = ([^;]+);/g)];
  const last = declarations.at(-1);
  return last ? [...last[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!) : [];
}

function brokerCalls(): BrokerCall[] {
  const calls: BrokerCall[] = [];
  for (const match of source.matchAll(/createSlackOpsContext\(\s*[^,()]+,\s*([^,]+),/g)) {
    const literal = match[1]!.trim().match(/^"([^"]+)"$/);
    // The helper's own declaration (`action: string`) is not a call.
    if (match[1]!.includes(":")) continue;
    calls.push({ action: literal ? literal[1]! : `<non-literal ${match[1]!.trim()}>`, line: lineOf(match.index!) });
  }
  for (const match of source.matchAll(/this\.mutation(?:Ops|Credential)Context\(\{([\s\S]*?)\n\s*\}\);/g)) {
    const body = match[1]!;
    const destructive = body.match(/\bdestructive:\s*([^,\n]+)/)?.[1]?.trim();
    const literal = body.match(/\baction:\s*"([^"]+)"/)?.[1];
    if (literal) {
      calls.push({ action: literal, line: lineOf(match.index!), ...(destructive ? { destructive } : {}) });
      continue;
    }
    const fromMethod = /\baction:\s*method\b/.test(body) ? methodLiterals(match.index!) : [];
    if (fromMethod.length === 0) {
      calls.push({ action: "<non-literal action>", line: lineOf(match.index!) });
      continue;
    }
    for (const action of fromMethod) {
      calls.push({ action, line: lineOf(match.index!), ...(destructive ? { destructive } : {}) });
    }
  }
  return calls;
}

function brokerClass(call: BrokerCall): ActionClass {
  if (call.destructive === "true" || isDestructiveAction(call.action)) return "destructive";
  return explainCredentialPolicy({ provider: "slack", connection: "any", action: call.action }).approval.required
    ? "write"
    : "read";
}

describe("Slack actions sent to the credential broker", () => {
  const calls = brokerCalls();

  it("finds the broker calls in slack.ts", () => {
    // Guards the extraction itself: a refactor that hides the calls from
    // these patterns must update the test, not silently pass with nothing.
    expect(calls.length).toBeGreaterThanOrEqual(35);
  });

  it("sends only literal actions, so each one can be classified", () => {
    expect(calls.filter((call) => call.action.startsWith("<")).map((call) => `slack.ts:${call.line}`)).toEqual([]);
  });

  it("classifies every action slack.ts sends, and nothing it does not send", () => {
    const sent = [...new Set(calls.map((call) => call.action))].sort();
    expect(sent).toEqual(Object.keys(SLACK_CREDENTIAL_ACTIONS).sort());
  });

  for (const [action, expected] of Object.entries(SLACK_CREDENTIAL_ACTIONS)) {
    it(`${action} is a ${expected} for the broker`, () => {
      const sites = calls.filter((call) => call.action === action);
      expect(sites.length).toBeGreaterThan(0);
      for (const call of sites) {
        expect({ line: call.line, class: brokerClass(call) }).toEqual({ line: call.line, class: expected });
      }
    });
  }

  it("marks the three whole-canvas publishers destructive with a literal true", () => {
    for (const action of ["slack.canvas.showcase", "slack.canvas.channelShowcase", "slack.canvas.artifact.publish"]) {
      const sites = calls.filter((call) => call.action === action);
      expect(sites.length).toBe(1);
      expect(sites[0]!.destructive).toBe("true");
      // The verb alone would not ask: only the mark makes these destructive.
      expect(isDestructiveAction(action)).toBe(false);
    }
  });

  it("allows a non-literal destructive mark only where the table expects one", () => {
    const conditional = calls
      .filter((call) => call.destructive !== undefined && call.destructive !== "true")
      .map((call) => [call.action, call.destructive]);
    expect(Object.fromEntries(conditional)).toEqual(CONDITIONAL_DESTRUCTIVE_MARKS);
  });
});
