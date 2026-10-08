import { describe, expect, it } from "bun:test";
import { getRegistry } from "../cli/registry-snapshot.js";
import {
  GATEWAY_RAVI_DISPATCH_COMMANDS,
  gatewayCommandProblem,
  lookupRaviRegistryCommand,
  type RaviCommandLookup,
} from "./gateway-command.js";
import { normalizeGatewayDeclaration } from "./gateway-declaration.js";

const POSITIONAL = normalizeGatewayDeclaration({ args: { options: ["--limit"], positional: 2 } })!;
const OPTIONS_ONLY = normalizeGatewayDeclaration({ args: { options: ["--limit"], flags: ["--archived"] } })!;
const NONE = normalizeGatewayDeclaration({ args: "none" })!;

// A small stand-in for the CLI registry: read commands, one mutate command,
// one command that also has subcommands, plus the dispatch commands.
const COMMANDS: Array<{ path: string[]; kind: "read" | "mutate" }> = [
  { path: ["tasks", "list"], kind: "read" },
  { path: ["tasks", "create"], kind: "mutate" },
  { path: ["contacts", "get"], kind: "read" },
  { path: ["crm", "account"], kind: "read" },
  { path: ["crm", "account", "show"], kind: "read" },
  { path: ["crm", "account", "create"], kind: "mutate" },
  { path: ["pages", "apps", "targets", "list"], kind: "read" },
  ...Array.from(GATEWAY_RAVI_DISPATCH_COMMANDS, (name) => ({ path: name.split("."), kind: "read" as const })),
];
const lookup: RaviCommandLookup = (words) => {
  let best: (typeof COMMANDS)[number] | null = null;
  for (const command of COMMANDS) {
    if (command.path.length <= words.length && command.path.every((segment, index) => words[index] === segment)) {
      if (!best || command.path.length > best.path.length) best = command;
    }
  }
  if (!best) return null;
  const match = best;
  return {
    fullName: match.path.join("."),
    words: match.path.length,
    hasSubcommands: COMMANDS.some(
      (other) =>
        other.path.length > match.path.length && match.path.every((segment, index) => other.path[index] === segment),
    ),
    kind: match.kind,
  };
};

function problem(command: string, declaration = POSITIONAL): string | null {
  return gatewayCommandProblem(command, declaration, lookup);
}

describe("gateway command shape", () => {
  it("accepts commands whose fixed part chooses what runs", () => {
    for (const command of [
      "slides list {args} --json",
      "slides list",
      "bun slides.mjs list {args} --json",
      "python3 script.py {args}",
      "bun run build {args}",
      "/opt/tools/slides list {args}",
      "ravi tasks list {args} --json",
      "ravi contacts get alice {args} --json",
      "ravi pages apps targets list {args} --json",
      "ravi crm account show {args} --json",
      "ravi crm account acc_1 {args} --json",
      "/usr/local/bin/ravi tasks list {args}",
      "ravi tasks list --status open {args} --json",
      "slides list --format json {args} --json",
    ]) {
      expect({ command, problem: problem(command) }).toEqual({ command, problem: null });
    }
  });

  it("refuses commands that let the viewer choose the subcommand or program", () => {
    for (const command of [
      "ravi {args}",
      "ravi contacts {args}",
      "ravi update {args}",
      "ravi slides {args}",
      "ravi --json tasks list {args}",
      "RAVI {args}",
      "ravi apps run slides {args}",
      "ravi jobs run {args}",
      "ravi commands run {args}",
      "ravi tools invoke {args}",
      "ravi tasks create {args}",
      "ravi crm account {args} --json",
      "ravi crm account --json {args}",
      "ravi crm account",
      "git {args}",
      "python3 {args}",
      "bash -c {args}",
      "python3 -m {args}",
      "node -e {args}",
      "slides {args} list",
      "bun slides.mjs {args} list",
      "python3 cli.py {args} --verbose delete",
      "slides list {args} --format json",
      "env FOO=1 {args}",
      "/usr/bin/env node cli.js {args}",
      "sudo slides list {args}",
      "npx {args}",
      "npx cowsay {args}",
      "npm run {args}",
      "npm exec -- {args}",
      "bun x {args}",
      "pnpm dlx {args}",
      "ssh host {args}",
      "slides list --json",
      "find . -exec {args}",
      "slides list --format {args}",
    ]) {
      expect({ command, refused: problem(command) !== null }).toEqual({ command, refused: true });
    }
  });

  it("lets option-only declarations follow a fixed option", () => {
    expect(problem("slides list --json", OPTIONS_ONLY)).toBeNull();
    expect(problem("slides list --json {args}", OPTIONS_ONLY)).toBeNull();
    expect(problem("git {args}", OPTIONS_ONLY)).not.toBeNull();
    // A declared option may be a boolean flag in the real command, so its
    // "value" would become the first operand.
    expect(problem("ravi crm account {args}", OPTIONS_ONLY)).not.toBeNull();
  });

  it("accepts any command when the declaration passes no viewer args", () => {
    expect(problem("ravi {args}", NONE)).toBeNull();
    expect(problem("bash -c 'echo ok'", NONE)).toBeNull();
  });

  it("explains the refusal", () => {
    expect(problem("ravi contacts {args}")).toContain("full Ravi CLI command");
    expect(problem("ravi apps run slides {args}")).toContain('"ravi apps run" runs whatever its args name');
    expect(problem("ravi tasks create {args}")).toContain('"ravi tasks create" changes state');
    expect(problem("ravi crm account {args} --json")).toContain('"ravi crm account" also has subcommands');
    expect(problem("env FOO=1 {args}")).toContain('"env" runs another program');
    expect(problem("git {args}")).toContain("nothing before {args}");
    expect(problem("npm run {args}")).toContain('"run" right before {args}');
    expect(problem("slides list --format {args}")).toContain('value of "--format"');
    expect(problem("bun slides.mjs {args} list")).toContain('"list" comes after {args}');
  });

  it("resolves Ravi commands against the real CLI registry", () => {
    const fullNames = new Set(getRegistry().commands.map((entry) => entry.fullName));
    for (const name of GATEWAY_RAVI_DISPATCH_COMMANDS)
      expect({ name, known: fullNames.has(name) }).toEqual({ name, known: true });

    expect(lookupRaviRegistryCommand(["tasks", "list"])).toMatchObject({
      fullName: "tasks.list",
      words: 2,
      hasSubcommands: false,
      kind: "read",
    });
    expect(lookupRaviRegistryCommand(["pages", "apps", "targets", "list"])?.fullName).toBe("pages.apps.targets.list");
    expect(lookupRaviRegistryCommand(["crm", "account"])).toMatchObject({ hasSubcommands: true, kind: "read" });
    expect(lookupRaviRegistryCommand(["tasks", "create"])?.kind).toBe("mutate");
    // Group and command aliases resolve to the canonical command.
    expect(lookupRaviRegistryCommand(["skills", "ls"])?.fullName).toBe("skills.list");
    expect(lookupRaviRegistryCommand(["calendar", "list"])?.fullName).toBe("calendars.list");
    expect(lookupRaviRegistryCommand(["contacts"])).toBeNull();
    expect(lookupRaviRegistryCommand(["doctor"])).toBeNull();
    expect(lookupRaviRegistryCommand([])).toBeNull();

    for (const command of [
      "ravi tasks list {args} --json",
      "ravi skills ls {args} --json",
      "ravi crm account show {args} --json",
    ]) {
      expect({ command, problem: gatewayCommandProblem(command, POSITIONAL) }).toEqual({ command, problem: null });
    }
    for (const command of [
      "ravi apps run slides {args}",
      "ravi crm account {args} --json",
      "ravi crm opportunity {args} --json",
      "ravi crm contact {args} --json",
      "ravi chats messages {args} --json",
      "ravi sessions send {args}",
      "ravi doctor {args} --json",
    ]) {
      expect({ command, refused: gatewayCommandProblem(command, POSITIONAL) !== null }).toEqual({
        command,
        refused: true,
      });
    }
  });
});
