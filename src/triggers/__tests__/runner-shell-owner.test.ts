import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerDirectTarget } from "../../knowledge/owner.js";
import { dbCreateAgent, getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

type BusEvent = { topic: string; data: unknown };

interface TopicChannel {
  push(event: BusEvent): void;
  close(): void;
}

const channels = new Map<string, TopicChannel>();
const subscribedTopics: string[] = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

function createTopicStream(topic: string): AsyncIterableIterator<BusEvent> {
  const queue: BusEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  channels.set(topic, {
    push(event) {
      queue.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  });
  const stream: AsyncIterableIterator<BusEvent> = {
    async next() {
      while (!closed && queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const value = queue.shift();
      return value ? { value, done: false } : { value: undefined, done: true };
    },
    async return() {
      closed = true;
      notify();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return stream;
}

// Who a direct message can reach, and what was sent: the notice goes out by direct message, with no model in the path.
const OPERATOR_CHAT: OwnerDirectTarget = {
  channel: "slack",
  accountId: "ops",
  to: "U_OPERATOR",
  chatId: "U_OPERATOR",
  contactId: "c_operator",
};
const ANA_CHAT: OwnerDirectTarget = {
  channel: "whatsapp",
  accountId: "main",
  to: "ana",
  chatId: "ana",
  contactId: "c_ana",
};
let operatorChat: OwnerDirectTarget | null = null;
const contactChats = new Map<string, OwnerDirectTarget>();
let directDeliveryFails = false;
const directMessages: Array<{ target: OwnerDirectTarget; text: string }> = [];
// Every chat a direct message was tried on, including the ones that failed.
const directAttempts: OwnerDirectTarget[] = [];

const actualNatsModule = await import("../../nats.js");
const actualSessionStreamModule = await import("../../omni/session-stream.js");
const actualOwnerModule = await import("../../knowledge/owner.js");
const actualChatTargetModule = await import("../../cloud-agents/chat-target.js");

// Only what a test armed is faked: with nothing armed these call through to the real ones, so the mocks
// are harmless to other files that share this process.
const actualResolveOwnerDirectTarget = actualOwnerModule.resolveOwnerDirectTarget;
const actualDeliverToChat = actualChatTargetModule.deliverToChat;
const directChatsArmed = () => operatorChat !== null || contactChats.size > 0;

mock.module("../../knowledge/owner.js", () => ({
  ...actualOwnerModule,
  // With a contact list: that contact's own chat. Without: the operator's.
  resolveOwnerDirectTarget: (deps?: Parameters<typeof actualResolveOwnerDirectTarget>[0]) => {
    if (!directChatsArmed()) return actualResolveOwnerDirectTarget(deps);
    const ids = deps?.listOwnerContactIds?.();
    return ids ? (contactChats.get(ids[0] ?? "") ?? null) : operatorChat;
  },
}));

mock.module("../../cloud-agents/chat-target.js", () => ({
  ...actualChatTargetModule,
  deliverToChat: mock(async (target: OwnerDirectTarget, message: { text: string }, timeoutMs?: number) => {
    if (!directChatsArmed()) return actualDeliverToChat(target, message, timeoutMs);
    directAttempts.push(target);
    if (directDeliveryFails) throw new Error("gateway offline");
    directMessages.push({ target, text: message.text });
    return { messageId: "m1", deliveries: [] };
  }),
}));

mock.module("../../nats.js", () => ({
  ...actualNatsModule,
  publish: mock(async () => {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock((topic: string) => {
      subscribedTopics.push(topic);
      return createTopicStream(topic);
    }),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { TriggerRunner } = await import("../runner.js");
const { dbCreateTrigger, dbGetTrigger } = await import("../triggers-db.js");

let stateDir: string | null = null;
let markerDir: string | null = null;
let runner: InstanceType<typeof TriggerRunner> | null = null;

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emit(topic: string, data: unknown, subscriptionTopic = topic): void {
  const channel = channels.get(subscriptionTopic);
  if (!channel) throw new Error(`Runner is not subscribed to ${subscriptionTopic}`);
  channel.push({ topic, data });
}

function markerPath(): string {
  return join(markerDir!, "shell-env.log");
}

function createShellTrigger(input: { name: string; topic: string; ownerPrincipal?: string; envFile?: string }) {
  return dbCreateTrigger({
    name: input.name,
    agentId: "trigger-test-agent",
    topic: input.topic,
    message: "",
    executionType: "shell",
    // Writes the env the command saw, one NAME=value per line.
    shellCommand: `env > '${markerPath()}'`,
    shellTimeoutMs: 10_000,
    shellEnvFile: input.envFile,
    ownerPrincipal: input.ownerPrincipal,
    session: "isolated",
    cooldownMs: 0,
  });
}

async function startRunner(): Promise<InstanceType<typeof TriggerRunner>> {
  runner = new TriggerRunner();
  await runner.start();
  return runner;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-shell-owner-test-");
  dbCreateAgent({ id: "trigger-test-agent", cwd: "/tmp/trigger-test-agent-real" });
  markerDir = mkdtempSync(join(tmpdir(), "ravi-trigger-shell-marker-"));
  channels.clear();
  subscribedTopics.length = 0;
  publishCalls.length = 0;
  operatorChat = null;
  contactChats.clear();
  directDeliveryFails = false;
  directMessages.length = 0;
  directAttempts.length = 0;
});

afterEach(async () => {
  await runner?.stop();
  operatorChat = null;
  contactChats.clear();
  directDeliveryFails = false;
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  markerDir = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("shell trigger owner and env", () => {
  it("never runs a shell trigger whose owner is not the operator, and turns it off once", async () => {
    const topic = "ravi.test.shell-owner";
    const unowned = createShellTrigger({ name: "no-owner", topic });
    const contact = createShellTrigger({ name: "contact-owner", topic, ownerPrincipal: "contact:c_ana" });
    await startRunner();

    emit(topic, { eventId: "evt-1" });
    await waitFor(() => !dbGetTrigger(unowned.id)?.enabled && !dbGetTrigger(contact.id)?.enabled);
    emit(topic, { eventId: "evt-2" });
    await sleep(300);

    expect(existsSync(markerPath())).toBe(false);
    expect(dbGetTrigger(unowned.id)?.fireCount).toBe(0);
    const notices = publishCalls.filter(({ payload }) => String(payload.prompt).includes("TRIGGER_SHELL_NOT_OPERATOR"));
    // One notice per trigger, never the command.
    expect(notices).toHaveLength(2);
    for (const notice of notices) expect(String(notice.payload.prompt)).not.toContain("env >");
  });

  it("runs an operator's shell trigger with the allowlisted env plus its env file", async () => {
    const topic = "ravi.test.shell-env";
    const envFile = join(markerDir!, "trigger.env");
    // Explicit mode: a file its group can write (umask 002) is refused.
    writeFileSync(envFile, "TRIGGER_ON_PURPOSE=from-env-file\n", { mode: 0o600 });
    const previous = process.env.RAVI_TRIGGER_TEST_CANARY_SECRET;
    process.env.RAVI_TRIGGER_TEST_CANARY_SECRET = "canary-trigger-secret";
    try {
      createShellTrigger({ name: "operator-shell", topic, ownerPrincipal: "operator", envFile });
      await startRunner();

      emit(topic, { eventId: "evt-env" });
      await waitFor(() => existsSync(markerPath()) && readFileSync(markerPath(), "utf8").includes("RAVI_TRIGGER_ID="));
      const seen = readFileSync(markerPath(), "utf8");
      expect(seen).not.toContain("RAVI_TRIGGER_TEST_CANARY_SECRET");
      expect(seen).not.toContain("canary-trigger-secret");
      expect(seen).toContain("TRIGGER_ON_PURPOSE=from-env-file");
      expect(seen).toContain("RAVI_AUTOMATION_PRINCIPAL=");
    } finally {
      if (previous === undefined) delete process.env.RAVI_TRIGGER_TEST_CANARY_SECRET;
      else process.env.RAVI_TRIGGER_TEST_CANARY_SECRET = previous;
    }
  });

  it("does not run an operator's shell trigger whose stored owner changed after the runner loaded it", async () => {
    const topic = "ravi.test.shell-stale";
    const trigger = createShellTrigger({ name: "stale-owner", topic, ownerPrincipal: "operator" });
    await startRunner();

    // An edit by someone else clears the owner in the database; the runner still holds the old copy.
    getDb().prepare("UPDATE triggers SET owner_principal = NULL WHERE id = ?").run(trigger.id);
    emit(topic, { eventId: "evt-stale" });
    await sleep(500);

    expect(existsSync(markerPath())).toBe(false);
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(0);
  });

  it("runs the command stored now when it changed after the runner loaded the trigger", async () => {
    const topic = "ravi.test.shell-swap";
    const trigger = createShellTrigger({ name: "swapped-command", topic, ownerPrincipal: "operator" });
    await startRunner();

    // The owner changes the command; the runner still holds the old copy until a refresh.
    getDb()
      .prepare("UPDATE triggers SET shell_command = ? WHERE id = ?")
      .run(`printf 'new-command\\n' > '${markerPath()}'`, trigger.id);
    emit(topic, { eventId: "evt-swap" });
    await waitFor(() => existsSync(markerPath()));

    // The stored command ran, not the loaded one (which would have written the env).
    expect(readFileSync(markerPath(), "utf8")).toBe("new-command\n");
  });

  it("does not run a shell trigger whose env file is inside the Ravi state dir", async () => {
    const topic = "ravi.test.shell-state-env";
    const stateEnvFile = join(stateDir!, ".env");
    writeFileSync(stateEnvFile, "RAVI_ADMIN_TOKEN=canary-state-env\n");
    createShellTrigger({ name: "state-env", topic, ownerPrincipal: "operator", envFile: stateEnvFile });
    await startRunner();

    emit(topic, { eventId: "evt-state-env" });
    await sleep(500);

    expect(existsSync(markerPath())).toBe(false);
  });

  it("does not run a shell trigger whose env file is a hard link", async () => {
    const topic = "ravi.test.shell-hard-link";
    const stateEnvFile = join(stateDir!, ".env");
    writeFileSync(stateEnvFile, "RAVI_ADMIN_TOKEN=canary-hard-link\n");
    const linked = join(markerDir!, "innocent.env");
    linkSync(stateEnvFile, linked);
    const trigger = createShellTrigger({ name: "hard-link-env", topic, ownerPrincipal: "operator", envFile: linked });
    await startRunner();

    emit(topic, { eventId: "evt-hard-link" });
    await waitFor(() => !dbGetTrigger(trigger.id)?.enabled);
    emit(topic, { eventId: "evt-hard-link-2" });
    await sleep(300);

    expect(existsSync(markerPath())).toBe(false);
    // Turned off once, with one notice that names the reason and not the file's content.
    const notices = publishCalls.filter(({ payload }) =>
      String(payload.prompt).includes("TRIGGER_SHELL_ENV_FILE_HARD_LINK"),
    );
    expect(notices).toHaveLength(1);
    expect(String(notices[0]!.payload.prompt)).not.toContain("canary-hard-link");
  });

  it("turns off a shell trigger whose env file grew over the loader's limit, with one notice", async () => {
    const topic = "ravi.test.shell-too-large";
    const envFile = join(markerDir!, "grown.env");
    writeFileSync(envFile, "TICKET_QUEUE=ops\n");
    const trigger = createShellTrigger({ name: "grown-env", topic, ownerPrincipal: "operator", envFile });
    await startRunner();

    // Saved within the limit, then grown past it.
    writeFileSync(envFile, `A=${"x".repeat(1024 * 1024)}\n`);
    emit(topic, { eventId: "evt-too-large" });
    await waitFor(() => !dbGetTrigger(trigger.id)?.enabled);
    emit(topic, { eventId: "evt-too-large-2" });
    await sleep(300);

    expect(existsSync(markerPath())).toBe(false);
    const notices = publishCalls.filter(({ payload }) =>
      String(payload.prompt).includes("TRIGGER_SHELL_ENV_FILE_TOO_LARGE"),
    );
    expect(notices).toHaveLength(1);
  });

  it("turns off a shell trigger whose env file became writable by others, with one notice", async () => {
    const topic = "ravi.test.shell-writable";
    const envFile = join(markerDir!, "shared.env");
    writeFileSync(envFile, "TICKET_QUEUE=ops\n", { mode: 0o600 });
    const trigger = createShellTrigger({ name: "writable-env", topic, ownerPrincipal: "operator", envFile });
    await startRunner();

    // Saved as its owner's file, then opened to everyone.
    chmodSync(envFile, 0o666);
    emit(topic, { eventId: "evt-writable" });
    await waitFor(() => !dbGetTrigger(trigger.id)?.enabled);
    emit(topic, { eventId: "evt-writable-2" });
    await sleep(300);

    expect(existsSync(markerPath())).toBe(false);
    const notices = publishCalls.filter(({ payload }) =>
      String(payload.prompt).includes("TRIGGER_SHELL_ENV_FILE_WRITABLE_BY_OTHERS"),
    );
    expect(notices).toHaveLength(1);
  });

  it("turns off a shell trigger whose env file became a symlink loop, with one notice", async () => {
    const topic = "ravi.test.shell-unverifiable";
    const envFile = join(markerDir!, "looped.env");
    writeFileSync(envFile, "TICKET_QUEUE=ops\n", { mode: 0o600 });
    const trigger = createShellTrigger({ name: "looped-env", topic, ownerPrincipal: "operator", envFile });
    await startRunner();

    // Saved as a regular file, then replaced by a loop the check cannot follow (ELOOP).
    rmSync(envFile);
    symlinkSync(`${envFile}.other`, envFile);
    symlinkSync(envFile, `${envFile}.other`);
    emit(topic, { eventId: "evt-unverifiable" });
    await waitFor(() => !dbGetTrigger(trigger.id)?.enabled);
    emit(topic, { eventId: "evt-unverifiable-2" });
    await sleep(300);

    expect(existsSync(markerPath())).toBe(false);
    const notices = publishCalls.filter(({ payload }) =>
      String(payload.prompt).includes("TRIGGER_SHELL_ENV_FILE_UNVERIFIABLE"),
    );
    expect(notices).toHaveLength(1);
  });
});

describe("shell trigger refusal notice", () => {
  const promptsAbout = (code: string) => publishCalls.filter(({ payload }) => String(payload.prompt).includes(code));

  it("tells the operator by direct message, not in the main session, when a trigger nobody owns is turned off", async () => {
    operatorChat = OPERATOR_CHAT;
    const topic = "ravi.test.notice-unowned";
    const trigger = createShellTrigger({ name: "Cards de aprovação", topic });
    await startRunner();

    emit(topic, { eventId: "evt-1" });
    await waitFor(() => directMessages.length === 1);
    emit(topic, { eventId: "evt-2" });
    await sleep(300);

    expect(dbGetTrigger(trigger.id)?.enabled).toBe(false);
    expect(existsSync(markerPath())).toBe(false);
    // One message, to the one person who can act: nobody owns the trigger.
    expect(directMessages).toHaveLength(1);
    expect(directMessages[0]!.target.contactId).toBe("c_operator");
    const { text } = directMessages[0]!;
    expect(text).toContain(
      `O gatilho de shell “Cards de aprovação” (${trigger.id}) foi desligado: TRIGGER_SHELL_NOT_OPERATOR.`,
    );
    expect(text).toContain("Nenhum comando foi executado.");
    expect(text).toContain(`ravi triggers show ${trigger.id}`);
    expect(text).not.toContain("env >");
    // The direct message was enough: nothing went to the main session's prompt.
    expect(promptsAbout("TRIGGER_SHELL_NOT_OPERATOR")).toHaveLength(0);
  });

  it("tells the operator alone, never the contact that owns it, and without the owner's id", async () => {
    operatorChat = OPERATOR_CHAT;
    contactChats.set("c_ana", ANA_CHAT);
    const topic = "ravi.test.notice-contact";
    createShellTrigger({ name: "contact-owner", topic, ownerPrincipal: "contact:c_ana" });
    await startRunner();

    emit(topic, { eventId: "evt-1" });
    await waitFor(() => directMessages.length === 1);
    emit(topic, { eventId: "evt-2" });
    await sleep(300);

    // The contact cannot act on it (only the operator can recreate a shell), and a message to
    // them would travel over whatever instance Ravi last saw them on: nothing is sent.
    expect(directAttempts.map((target) => target.contactId)).toEqual(["c_operator"]);
    expect(directMessages.map(({ target }) => target.contactId)).toEqual(["c_operator"]);
    const { text } = directMessages[0]!;
    expect(text).toContain("TRIGGER_SHELL_NOT_OPERATOR");
    expect(text).not.toContain("contact:");
    expect(text).not.toContain("c_ana");
    expect(promptsAbout("TRIGGER_SHELL_NOT_OPERATOR")).toHaveLength(0);
  });

  it("falls back to the main session's prompt when the operator's chat does not resolve, though the owner has one", async () => {
    // No contact is tagged as the operator (or more than one is): the operator would hear nothing.
    contactChats.set("c_ana", ANA_CHAT);
    const topic = "ravi.test.notice-no-operator-chat";
    const trigger = createShellTrigger({ name: "no-operator-chat", topic, ownerPrincipal: "contact:c_ana" });
    await startRunner();

    emit(topic, { eventId: "evt-1" });
    await waitFor(() => promptsAbout("TRIGGER_SHELL_NOT_OPERATOR").length === 1);
    emit(topic, { eventId: "evt-2" });
    await sleep(300);

    expect(dbGetTrigger(trigger.id)?.enabled).toBe(false);
    expect(directAttempts).toHaveLength(0);
    const notices = promptsAbout("TRIGGER_SHELL_NOT_OPERATOR");
    expect(notices).toHaveLength(1);
    expect(String(notices[0]!.payload.prompt)).toContain("Shell trigger disabled (TRIGGER_SHELL_NOT_OPERATOR)");
  });

  it("falls back to the main session's prompt when the message to the operator fails, though the owner has a chat", async () => {
    operatorChat = OPERATOR_CHAT;
    contactChats.set("c_ana", ANA_CHAT);
    directDeliveryFails = true;
    const topic = "ravi.test.notice-operator-delivery-fails";
    const trigger = createShellTrigger({ name: "operator-delivery-fails", topic, ownerPrincipal: "contact:c_ana" });
    await startRunner();

    emit(topic, { eventId: "evt-1" });
    await waitFor(() => promptsAbout("TRIGGER_SHELL_NOT_OPERATOR").length === 1);
    emit(topic, { eventId: "evt-2" });
    await sleep(300);

    expect(dbGetTrigger(trigger.id)?.enabled).toBe(false);
    expect(directMessages).toHaveLength(0);
    // Only the operator was tried; the contact was never messaged.
    expect(directAttempts.map((target) => target.contactId)).toEqual(["c_operator"]);
    expect(promptsAbout("TRIGGER_SHELL_NOT_OPERATOR")).toHaveLength(1);
  });

  it("tells the owner who acts as the operator about a refused env file, without the file's content", async () => {
    operatorChat = OPERATOR_CHAT;
    const topic = "ravi.test.notice-env-file";
    const stateEnvFile = join(stateDir!, ".env");
    writeFileSync(stateEnvFile, "RAVI_ADMIN_TOKEN=canary-notice-content\n");
    const linked = join(markerDir!, "innocent.env");
    linkSync(stateEnvFile, linked);
    const trigger = createShellTrigger({ name: "hard-link-env", topic, ownerPrincipal: "operator", envFile: linked });
    await startRunner();

    emit(topic, { eventId: "evt-1" });
    await waitFor(() => directMessages.length === 1);
    emit(topic, { eventId: "evt-2" });
    await sleep(300);

    expect(dbGetTrigger(trigger.id)?.enabled).toBe(false);
    expect(directMessages).toHaveLength(1);
    const { text } = directMessages[0]!;
    expect(text).toContain("TRIGGER_SHELL_ENV_FILE_HARD_LINK");
    expect(text).toContain(`ravi triggers set ${trigger.id} env-file CAMINHO_DO_ARQUIVO`);
    expect(text).not.toContain("canary-notice-content");
    expect(text).not.toContain(linked);
    expect(promptsAbout("TRIGGER_SHELL_ENV_FILE_HARD_LINK")).toHaveLength(0);
  });

  it("falls back to the main session's prompt when the direct message cannot be sent", async () => {
    operatorChat = OPERATOR_CHAT;
    directDeliveryFails = true;
    const topic = "ravi.test.notice-fallback";
    const trigger = createShellTrigger({ name: "no-owner", topic });
    await startRunner();

    emit(topic, { eventId: "evt-1" });
    await waitFor(() => promptsAbout("TRIGGER_SHELL_NOT_OPERATOR").length === 1);
    emit(topic, { eventId: "evt-2" });
    await sleep(300);

    // Never silent: the prompt the runner always sent still goes out, once.
    expect(directMessages).toHaveLength(0);
    expect(dbGetTrigger(trigger.id)?.enabled).toBe(false);
    const notices = promptsAbout("TRIGGER_SHELL_NOT_OPERATOR");
    expect(notices).toHaveLength(1);
    expect(String(notices[0]!.payload.prompt)).toContain("Shell trigger disabled (TRIGGER_SHELL_NOT_OPERATOR)");
    expect(String(notices[0]!.payload.prompt)).not.toContain("env >");
  });
});
