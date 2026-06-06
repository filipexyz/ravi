import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "bun:test";

const SCRIPT_URL = new URL("../../extensions/whatsapp-overlay/vibes.js", import.meta.url);
const SCRIPT_SOURCE = readFileSync(SCRIPT_URL, "utf8");
const SANDBOX_SCRIPT_URL = new URL("../../extensions/whatsapp-overlay/vibes-sandbox.js", import.meta.url);
const SANDBOX_SCRIPT_SOURCE = readFileSync(SANDBOX_SCRIPT_URL, "utf8");
const STORAGE_KEY = "ravi-wa-vibes-preferences";
const SANDBOX_SOURCE = "ravi-wa-vibes-sandbox";

describe("whatsapp overlay extension vibes", () => {
  it("does not create an AudioContext during init, even when prefs are enabled", async () => {
    const { api, createdContexts } = loadVibes({
      [STORAGE_KEY]: { enabled: true, muted: false, volume: 0.2, engine: "native" },
    });

    await api.init();

    expect(createdContexts).toHaveLength(0);
    expect(api.getStatus()).toMatchObject({
      enabled: true,
      started: false,
      audible: false,
      scene: "jazz",
    });
  });

  it("starts audio only from the user gesture path and stores preferences only", async () => {
    const { api, createdContexts, store } = loadVibes();

    await api.init();
    await api.enableFromUserGesture();
    api.syncSnapshot(
      {
        ok: true,
        session: {
          sessionName: "dev",
          agentId: "dev",
          live: {
            activity: "thinking",
            updatedAt: 1,
            events: [
              {
                kind: "prompt",
                timestamp: 1,
                detail: "secret prompt",
                metadata: { prompt: "secret prompt", response: "secret response" },
              },
            ],
          },
        },
      },
      { chatId: "120363410237809091@g.us", title: "private chat title" },
    );

    expect(createdContexts).toHaveLength(1);
    expect(api.getStatus()).toMatchObject({
      enabled: true,
      started: true,
      audible: true,
      state: "thinking",
    });
    const stored = store.get(STORAGE_KEY);
    expect(stored).toEqual({
      enabled: true,
      muted: false,
      volume: 0.18,
      engine: "strudel",
      scene: "jazz",
      sceneDefaultVersion: 3,
      accentChatEvents: false,
    });
    expect(JSON.stringify([...store.entries()])).not.toContain("secret prompt");
    expect(JSON.stringify([...store.entries()])).not.toContain("private chat title");
  });

  it("derives stable but different buckets for different chats", () => {
    const { api } = loadVibes();

    const first = api._test.deriveVibeProfile({
      context: { chatId: "chat-a", title: "Private Chat A" },
      session: { sessionName: "dev", agentId: "dev", provider: "codex" },
    });
    const again = api._test.deriveVibeProfile({
      context: { chatId: "chat-a", title: "Private Chat A" },
      session: { sessionName: "dev", agentId: "dev", provider: "codex" },
    });
    const second = api._test.deriveVibeProfile({
      context: { chatId: "chat-b", title: "Private Chat B" },
      session: { sessionName: "dev", agentId: "dev", provider: "codex" },
    });

    expect(first.key).toBe(again.key);
    expect(first.key).not.toBe(second.key);
    expect(JSON.stringify(first)).not.toContain("Private Chat A");
    expect(JSON.stringify(first)).not.toContain("chat-a");
  });

  it("uses only safe relative path buckets for file context", () => {
    const { api } = loadVibes();

    expect(api._test.normalizeSafePathToken("/Users/luis/dev/secret.ts")).toBeNull();
    expect(api._test.normalizeSafePathToken("../secret.ts")).toBeNull();
    expect(api._test.normalizeSafePathToken("https://example.com/secret.js")).toBeNull();

    const safe = api._test.normalizeSafePathToken("src/events/audit-stream.ts");
    expect(safe).toMatchObject({ extension: "ts" });
    expect(safe?.bucket).toStartWith("path-src-");
    expect(JSON.stringify(safe)).not.toContain("audit-stream.ts");
  });

  it("maps selected session live state to native vibe state", async () => {
    const { api } = loadVibes();

    await api.init();
    await api.enableFromUserGesture();
    api.syncSnapshot({
      ok: true,
      session: {
        sessionName: "dev",
        live: {
          activity: "thinking",
          updatedAt: 1,
          events: [{ kind: "tool", timestamp: 1, metadata: { event: "start", toolName: "exec" } }],
        },
      },
    });

    expect(api.getStatus().state).toBe("tooling");
    expect(api.getStatus().visual.phase).toBe("working");
    expect(api.getStatus().visual.activity).toBeGreaterThan(0);

    api.syncSnapshot({
      ok: true,
      session: {
        sessionName: "dev",
        live: {
          activity: "blocked",
          updatedAt: 2,
          events: [{ kind: "runtime", timestamp: 2, metadata: { type: "turn.failed" } }],
        },
      },
    });

    expect(api.getStatus().state).toBe("failed");
  });

  it("represents active parallel sessions as bounded voice lanes", async () => {
    const { api } = loadVibes();

    await api.init();
    await api.enableFromUserGesture();
    api.syncSnapshot(
      {
        ok: true,
        session: {
          sessionName: "primary-dev",
          agentId: "dev",
          live: {
            activity: "thinking",
            updatedAt: 10,
            events: [{ kind: "runtime", timestamp: 10, metadata: { type: "prompt.received" } }],
          },
        },
        activeSessions: [
          {
            sessionName: "primary-dev",
            agentId: "dev",
            live: { activity: "thinking", updatedAt: 10, events: [] },
          },
          {
            sessionName: "secondary-build",
            agentId: "builder",
            boundTitle: "Private Parallel Chat",
            live: {
              activity: "thinking",
              updatedAt: 12,
              events: [{ kind: "tool", timestamp: 12, metadata: { event: "start", toolName: "exec" } }],
            },
          },
          {
            sessionName: "secondary-reply",
            agentId: "writer",
            live: {
              activity: "streaming",
              updatedAt: 13,
              events: [{ kind: "response", timestamp: 13, metadata: { response: "secret response" } }],
            },
          },
        ],
      },
      { chatId: "private-chat-id", title: "Private Chat Title" },
    );

    const status = api.getStatus();
    expect(status.voices).toHaveLength(3);
    expect(status.voices[0]).toMatchObject({ role: "primary", label: "primary-dev", state: "thinking" });
    expect(status.voices.some((voice) => voice.role === "secondary" && voice.state === "tooling")).toBe(true);
    expect(status.voices.some((voice) => voice.role === "secondary" && voice.state === "responding")).toBe(true);
    expect(status.visual.voices).toBe(3);
    expect(JSON.stringify(status.voices)).not.toContain("Private Chat Title");
    expect(JSON.stringify(status.voices)).not.toContain("Private Parallel Chat");
    expect(JSON.stringify(status.voices)).not.toContain("secret response");
  });

  it("keeps visual lanes for active sessions found in the recent list", async () => {
    const { api } = loadVibes();

    await api.init();
    await api.enableFromUserGesture();
    api.syncSnapshot({
      ok: true,
      session: {
        sessionName: "primary-dev",
        agentId: "dev",
        live: {
          activity: "thinking",
          updatedAt: 10,
          events: [{ kind: "runtime", timestamp: 10, metadata: { type: "prompt.received" } }],
        },
      },
      activeSessions: [],
      recentSessions: [
        {
          sessionName: "parallel-tooling",
          agentId: "builder",
          live: {
            activity: "thinking",
            updatedAt: 12,
            events: [{ kind: "tool", timestamp: 12, metadata: { event: "start" } }],
          },
        },
        {
          sessionName: "recent-idle",
          agentId: "idle",
          live: { activity: "idle", updatedAt: 11, events: [] },
        },
      ],
    });

    const status = api.getStatus();
    expect(status.voices).toHaveLength(2);
    expect(status.voices[0]).toMatchObject({ role: "primary", state: "thinking" });
    expect(status.voices[1]).toMatchObject({ role: "secondary", state: "tooling" });
    expect(status.voices[1].gain).toBeGreaterThan(0.3);
  });

  it("keeps the Strudel sandbox aligned with Agent Vibes by avoiding continuous secondary layers", () => {
    expect(SANDBOX_SCRIPT_SOURCE).toContain("initAudio");
    expect(SANDBOX_SCRIPT_SOURCE).not.toContain("secondaryVoiceLayers");
  });

  it("feeds every unseen live event through the conductor instead of only the latest snapshot state", async () => {
    const { api, frames } = loadVibes({}, { sandbox: true });

    await api.init();
    await api.enableFromUserGesture();
    api.syncSnapshot({
      ok: true,
      session: {
        sessionName: "dev",
        agentId: "dev",
        live: {
          activity: "thinking",
          updatedAt: 3,
          events: [
            { kind: "tool", timestamp: 3, metadata: { event: "start", toolName: "exec" } },
            { kind: "runtime", timestamp: 2, metadata: { type: "prompt.received" } },
          ],
        },
      },
    });

    const accentMessages = frames[0].contentWindow.messages.filter((message) => message.type === "vibes.accent");
    expect(accentMessages.length).toBeGreaterThanOrEqual(2);
    expect(api.getStatus().visual.phase).toBe("working");

    api.syncSnapshot({
      ok: true,
      session: {
        sessionName: "dev",
        agentId: "dev",
        live: {
          activity: "thinking",
          updatedAt: 3,
          events: [
            { kind: "tool", timestamp: 3, metadata: { event: "start", toolName: "exec" } },
            { kind: "runtime", timestamp: 2, metadata: { type: "prompt.received" } },
          ],
        },
      },
    });

    const replayedAccentMessages = frames[0].contentWindow.messages.filter(
      (message) => message.type === "vibes.accent",
    );
    expect(replayedAccentMessages).toHaveLength(accentMessages.length);
  });

  it("uses sanitized composer draft metrics without storing draft text", async () => {
    const { api, store } = loadVibes();

    await api.init();
    await api.enableFromUserGesture();
    api.syncComposerDraft({
      length: 42,
      text: "secret composer text",
      context: { chatId: "private-chat-id", title: "Private Chat Title" },
    });

    expect(api.getStatus().state).toBe("thinking");
    expect(api.getStatus().visual.phase).toBe("prompting");
    expect(JSON.stringify([...store.entries()])).not.toContain("secret composer text");
    expect(JSON.stringify([...store.entries()])).not.toContain("Private Chat Title");
    expect(JSON.stringify([...store.entries()])).not.toContain("private-chat-id");
  });

  it("uses continuous music by default and ignores legacy pulse preferences", async () => {
    const { api, createdContexts, store } = loadVibes({
      [STORAGE_KEY]: {
        enabled: false,
        muted: false,
        volume: 0.18,
        engine: "strudel",
        mode: "pulse",
        modeExplicit: true,
        scene: "jazz",
        sceneDefaultVersion: 3,
      },
    });

    await api.init();
    expect(store.get(STORAGE_KEY)).toEqual({
      enabled: false,
      muted: false,
      volume: 0.18,
      engine: "strudel",
      scene: "jazz",
      sceneDefaultVersion: 3,
      accentChatEvents: false,
    });

    await api.enableFromUserGesture();

    expect(api.getStatus()).toMatchObject({
      state: "idle",
      bedActive: true,
    });
    expect(createdContexts[0].createdOscillators.length).toBeGreaterThan(2);
    const bedGain = createdContexts[0].createdGains[1];

    api.syncSnapshot({
      ok: true,
      session: {
        sessionName: "dev",
        live: {
          activity: "thinking",
          updatedAt: 1,
          events: [{ kind: "runtime", timestamp: 1, metadata: { type: "prompt.received" } }],
        },
      },
    });

    expect(api.getStatus()).toMatchObject({
      state: "thinking",
      bedActive: true,
    });
    expect(api.getStatus().visual.phase).toBe("prompting");

    expect(api.getStatus().bedActive).toBe(true);
    await api.disable();
    expect(api.getStatus().bedActive).toBe(false);
    expect(bedGain.gain.value).toBe(0);
  });

  it("uses the Strudel sandbox when available and sends only bounded control messages", async () => {
    const { api, createdContexts, frames, store } = loadVibes({}, { sandbox: true });

    await api.init();
    await api.enableFromUserGesture();

    expect(createdContexts).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(api.getStatus()).toMatchObject({
      enabled: true,
      started: true,
      engine: "strudel",
      preferredEngine: "strudel",
      audible: true,
    });
    expect(store.get(STORAGE_KEY)).toMatchObject({ engine: "strudel" });

    api.syncSnapshot(
      {
        ok: true,
        session: {
          sessionName: "dev",
          agentId: "dev",
          live: {
            activity: "thinking",
            updatedAt: 1,
            events: [
              {
                kind: "tool",
                timestamp: 1,
                metadata: {
                  event: "start",
                  toolName: "exec",
                  input: "secret tool input",
                  workspaceRelativePath: "src/events/audit-stream.ts",
                },
              },
            ],
          },
        },
      },
      { chatId: "private-chat-id", title: "Private Chat Title" },
    );

    const sent = frames[0].contentWindow.messages;
    const text = JSON.stringify(sent);
    expect(sent.some((message) => message.type === "vibes.init")).toBe(true);
    expect(sent.some((message) => message.type === "vibes.start")).toBe(true);
    expect(sent.some((message) => message.type === "vibes.accent")).toBe(true);
    const accent = sent.find((message) => message.type === "vibes.accent");
    expect(typeof accent?.key).toBe("string");
    expect(typeof accent?.scaleMode).toBe("string");
    expect(text).not.toContain("mode");
    expect(text).not.toContain("secret tool input");
    expect(text).not.toContain("Private Chat Title");
    expect(text).not.toContain("private-chat-id");
    expect(text).not.toContain("audit-stream.ts");

    await api.disable();

    expect(frames[0].contentWindow.messages.at(-1)).toMatchObject({ type: "vibes.stop" });
    expect(frames[0].removed).toBe(true);
  });

  it("keeps parallel session lanes visual and sends only primary audio controls to the Strudel sandbox", async () => {
    const { api, frames } = loadVibes({}, { sandbox: true });

    await api.init();
    await api.enableFromUserGesture();
    api.syncSnapshot(
      {
        ok: true,
        session: {
          sessionName: "primary-dev",
          agentId: "dev",
          live: {
            activity: "thinking",
            updatedAt: 1,
            events: [{ kind: "runtime", timestamp: 1, metadata: { type: "prompt.received" } }],
          },
        },
        activeSessions: [
          {
            sessionName: "Secondary Secret Session",
            agentId: "builder",
            live: {
              activity: "thinking",
              updatedAt: 2,
              events: [{ kind: "tool", timestamp: 2, metadata: { event: "start", toolName: "exec" } }],
            },
          },
        ],
      },
      { chatId: "private-chat-id", title: "Private Chat Title" },
    );

    const sent = frames[0].contentWindow.messages;
    const status = api.getStatus();
    expect(status.voices).toHaveLength(2);
    expect(status.voices[1]).toMatchObject({ role: "secondary", state: "tooling" });
    const voiceMessage = [...sent]
      .reverse()
      .find((message) => Array.isArray(message.voices) && message.voices.length > 0);
    expect(voiceMessage?.voices).toHaveLength(1);
    expect(voiceMessage?.voices[0]).toMatchObject({ role: "primary", state: "thinking" });
    expect(voiceMessage?.voices[0]).not.toHaveProperty("label");
    expect(voiceMessage?.voices[0]).not.toHaveProperty("provider");
    const text = JSON.stringify(sent);
    expect(text).not.toContain("Secondary Secret Session");
    expect(text).not.toContain("Private Chat Title");
    expect(text).not.toContain("private-chat-id");
  });

  it("falls back to native when the Strudel sandbox reports startup failure", async () => {
    const { api, createdContexts, frames } = loadVibes({}, { sandbox: true, sandboxError: true });

    await api.init();
    await api.enableFromUserGesture();

    expect(frames).toHaveLength(1);
    expect(frames[0].removed).toBe(true);
    expect(frames[0].contentWindow.messages.at(-1)).toMatchObject({ type: "vibes.stop" });
    expect(createdContexts).toHaveLength(1);
    expect(api.getStatus()).toMatchObject({
      engine: "native",
      preferredEngine: "strudel",
      started: true,
      bedActive: true,
    });
  });

  it("stores only bounded visual controls and drops legacy mode values", async () => {
    const { api, store } = loadVibes({
      [STORAGE_KEY]: {
        enabled: true,
        muted: false,
        volume: 9,
        engine: "strudel",
        mode: "pulse",
        modeExplicit: true,
        scene: "bad",
      },
    });

    await api.init();

    expect(api.getStatus()).toMatchObject({
      volume: 0.3,
      engine: "strudel",
      scene: "jazz",
    });

    await api.setScene("jazz");
    await api.setMode("pulse");
    await api.setVolume(-1);

    expect(store.get(STORAGE_KEY)).toEqual({
      enabled: true,
      muted: false,
      volume: 0,
      engine: "strudel",
      scene: "jazz",
      sceneDefaultVersion: 3,
      accentChatEvents: false,
    });
  });

  it("migrates old Agent Vibes scene preferences to the demo jazz default only once", async () => {
    const legacy = loadVibes({
      [STORAGE_KEY]: {
        enabled: true,
        muted: false,
        volume: 0.18,
        engine: "strudel",
        scene: "cinematic",
      },
    });

    await legacy.api.init();

    expect(legacy.api.getStatus().scene).toBe("jazz");
    expect(legacy.store.get(STORAGE_KEY)).toMatchObject({
      scene: "jazz",
      sceneDefaultVersion: 3,
    });

    const retroLegacy = loadVibes({
      [STORAGE_KEY]: {
        enabled: true,
        muted: false,
        volume: 0.18,
        engine: "strudel",
        scene: "chiptune",
        sceneDefaultVersion: 2,
      },
    });

    await retroLegacy.api.init();

    expect(retroLegacy.api.getStatus().scene).toBe("jazz");
    expect(retroLegacy.store.get(STORAGE_KEY)).toMatchObject({
      scene: "jazz",
      sceneDefaultVersion: 3,
    });

    const explicit = loadVibes({
      [STORAGE_KEY]: {
        enabled: true,
        muted: false,
        volume: 0.18,
        engine: "strudel",
        scene: "cinematic",
        sceneDefaultVersion: 3,
      },
    });

    await explicit.api.init();

    expect(explicit.api.getStatus().scene).toBe("cinematic");
  });

  it("restarts the Strudel sandbox after volume is raised from zero", async () => {
    const sandbox = loadVibesSandbox();
    const token = "sandbox-token-1234";

    await sandbox.send({ type: "vibes.init", token });
    await sandbox.send({
      type: "vibes.start",
      token,
      state: "thinking",
      scene: "jazz",
      volume: 0.18,
      muted: false,
      seed: "v1",
      visual: { intensity: 0.42, tension: 0.18, cps: 0.58, phase: "working" },
    });

    expect(sandbox.initCalls).toBe(1);
    expect(sandbox.initAudioCalls).toBe(1);
    expect(sandbox.evaluations.length).toBe(1);

    await sandbox.send({ type: "vibes.volume", token, volume: 0, muted: false });
    expect(sandbox.hushCalls).toBe(1);

    await sandbox.send({ type: "vibes.volume", token, volume: 0.18, muted: false });
    expect(sandbox.initCalls).toBe(1);
    expect(sandbox.evaluations.length).toBe(2);
    expect(sandbox.parentMessages.some((message) => message.type === "vibes.started")).toBe(true);
  });
});

function loadVibes(initialStorage = {}, options = {}) {
  const store = new Map(Object.entries(initialStorage));
  const createdContexts = [];
  const frames = [];
  const messageListeners = new Set();
  let timerId = 0;
  const timers = new Map();
  const AudioContext = createFakeAudioContext(createdContexts);
  const document = options.sandbox
    ? createFakeDocumentWithSandbox(frames, messageListeners, options)
    : {
        hidden: false,
        __raviVibesVisibilityAttached: false,
        addEventListener() {},
      };
  const context = {
    console,
    Date,
    Math,
    Number,
    Set,
    Map,
    Promise,
    String,
    JSON,
    AudioContext,
    webkitAudioContext: AudioContext,
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener(event, listener) {
      if (event === "message" && typeof listener === "function") {
        messageListeners.add(listener);
      }
    },
    removeEventListener(event, listener) {
      if (event === "message") {
        messageListeners.delete(listener);
      }
    },
    document,
    chrome: {
      runtime: options.sandbox ? { getURL: (path) => `chrome-extension://ravi/${path}` } : undefined,
      storage: {
        local: {
          get(key, callback) {
            const result = {};
            const keys = Array.isArray(key) ? key : [key];
            for (const item of keys) {
              if (store.has(item)) result[item] = store.get(item);
            }
            callback?.(result);
          },
          set(items, callback) {
            for (const [key, value] of Object.entries(items || {})) {
              store.set(key, value);
            }
            callback?.();
          },
        },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(SCRIPT_SOURCE, context, { filename: SCRIPT_URL.pathname });
  return { api: context.__RAVI_WA_VIBES__, createdContexts, frames, store };
}

function loadVibesSandbox() {
  const listeners = new Map();
  const evaluations = [];
  const parentMessages = [];
  const fakeAudioContext = {
    state: "running",
    resume() {
      this.state = "running";
    },
  };
  const sandbox = {
    initCalls: 0,
    initAudioCalls: 0,
    hushCalls: 0,
    evaluations,
    parentMessages,
    async send(message) {
      listeners.get("message")?.({ data: message });
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
  const window = {
    AudioContext: class {
      constructor() {
        Object.assign(this, fakeAudioContext);
      }
    },
    parent: {
      postMessage(message) {
        parentMessages.push(message);
      },
    },
    addEventListener(event, listener) {
      listeners.set(event, listener);
    },
    initStrudel: async () => {
      sandbox.initCalls += 1;
    },
    initAudio: async () => {
      sandbox.initAudioCalls += 1;
    },
    getAudioContext: () => fakeAudioContext,
    evaluate: async (code) => {
      evaluations.push(code);
    },
    hush: () => {
      sandbox.hushCalls += 1;
    },
  };
  vm.runInNewContext(
    SANDBOX_SCRIPT_SOURCE,
    { window, Date, Math, Number, String, Array, Set, Promise },
    { filename: SANDBOX_SCRIPT_URL.pathname },
  );
  return sandbox;
}

function createFakeDocumentWithSandbox(frames, messageListeners, options = {}) {
  return {
    hidden: false,
    __raviVibesVisibilityAttached: false,
    body: {
      appendChild(frame) {
        frames.push(frame);
        frame.dispatchLoad();
        return frame;
      },
    },
    addEventListener() {},
    createElement(tag) {
      if (tag !== "iframe") throw new Error(`unsupported element ${tag}`);
      const listeners = new Map();
      const frame = {
        allow: "",
        contentWindow: {
          messages: [],
          postMessage(message) {
            this.messages.push(message);
            if (message?.type !== "vibes.start") return;
            const response = options.sandboxError
              ? { source: SANDBOX_SOURCE, type: "vibes.error", message: "fake startup failure" }
              : { source: SANDBOX_SOURCE, type: "vibes.started", contextState: "running" };
            queueMicrotask(() => {
              for (const listener of messageListeners) {
                listener({ source: this, data: response });
              }
            });
          },
        },
        removed: false,
        style: {},
        setAttribute(key, value) {
          this[key] = value;
        },
        addEventListener(event, listener) {
          listeners.set(event, listener);
        },
        dispatchLoad() {
          listeners.get("load")?.();
        },
        remove() {
          this.removed = true;
        },
      };
      return frame;
    },
  };
}

function createFakeAudioContext(createdContexts) {
  class FakeAudioParam {
    constructor(value = 0) {
      this.value = value;
    }
    cancelScheduledValues() {}
    setValueAtTime(value) {
      this.value = value;
    }
    linearRampToValueAtTime(value) {
      this.value = value;
    }
  }

  class FakeNode {
    connect() {
      return this;
    }
  }

  class FakeOscillator extends FakeNode {
    constructor() {
      super();
      this.type = "sine";
      this.frequency = new FakeAudioParam(0);
      this.started = false;
    }
    start(time = 0) {
      this.started = true;
      this.startTime = time;
    }
    stop() {
      this.stopped = true;
    }
  }

  class FakeGain extends FakeNode {
    constructor() {
      super();
      this.gain = new FakeAudioParam(1);
    }
  }

  class FakePanner extends FakeNode {
    constructor() {
      super();
      this.pan = new FakeAudioParam(0);
    }
  }

  return class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = "running";
      this.destination = new FakeNode();
      this.createdOscillators = [];
      this.createdGains = [];
      createdContexts.push(this);
    }
    createGain() {
      const gain = new FakeGain();
      this.createdGains.push(gain);
      return gain;
    }
    createOscillator() {
      const oscillator = new FakeOscillator();
      this.createdOscillators.push(oscillator);
      return oscillator;
    }
    createStereoPanner() {
      return new FakePanner();
    }
    async resume() {
      this.state = "running";
    }
  };
}
