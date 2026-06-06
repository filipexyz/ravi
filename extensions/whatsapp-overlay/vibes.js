(function () {
  const STORAGE_KEY = "ravi-wa-vibes-preferences";
  const SANDBOX_SOURCE = "ravi-wa-vibes-sandbox";
  const DEFAULT_VOLUME = 0.18;
  const DEFAULT_SCENE_VERSION = 3;
  const DEFAULT_PREFS = Object.freeze({
    enabled: false,
    muted: false,
    volume: DEFAULT_VOLUME,
    engine: "strudel",
    scene: "jazz",
    sceneDefaultVersion: DEFAULT_SCENE_VERSION,
    accentChatEvents: false,
  });
  const SCENE_IDS = ["cinematic", "techno", "lofi", "chiptune", "piano", "jazz"];
  const SCENE_CONFIG = Object.freeze({
    cinematic: { label: "cinematic", accent: "#ff8a3d", accent2: "#4a90d9", baseRatio: 1, tempoFloor: 0.45 },
    techno: { label: "techno", accent: "#e0564a", accent2: "#ff2d6b", baseRatio: 1.12, tempoFloor: 0.55 },
    lofi: { label: "lofi", accent: "#b48ce0", accent2: "#f6b59b", baseRatio: 0.88, tempoFloor: 0.42 },
    chiptune: { label: "chiptune", accent: "#4ac06b", accent2: "#a6e85a", baseRatio: 1.2, tempoFloor: 0.6 },
    piano: { label: "piano", accent: "#ffffff", accent2: "#aeb4c0", baseRatio: 0.95, tempoFloor: 0.38 },
    jazz: { label: "jazz", accent: "#e3a948", accent2: "#5aa6b8", baseRatio: 0.92, tempoFloor: 0.46 },
  });
  const MUSIC_KEYS = ["c", "d", "e", "f", "g", "a"];
  const SCALE_MODES_BY_SCENE = Object.freeze({
    cinematic: ["minor", "dorian", "aeolian", "phrygian"],
    techno: ["minor", "phrygian", "locrian"],
    lofi: ["dorian", "major", "mixolydian", "lydian"],
    chiptune: ["major", "mixolydian", "lydian", "minor"],
    piano: ["minor", "aeolian", "dorian", "lydian"],
    jazz: ["dorian", "mixolydian", "aeolian", "lydian"],
  });
  const CPS_RANGE_BY_SCENE = Object.freeze({
    cinematic: [0.45, 0.85],
    techno: [0.55, 0.95],
    lofi: [0.42, 0.62],
    chiptune: [0.6, 1.0],
    piano: [0.38, 0.66],
    jazz: [0.46, 0.74],
  });
  const ACTIVE_STATES = new Set([
    "queued",
    "thinking",
    "tooling",
    "responding",
    "awaiting-approval",
    "compacting",
  ]);
  const EDGE_ACCENT_STATES = new Set(["failed", "interrupted"]);
  const SAFE_STATE_BY_ACTIVITY = Object.freeze({
    idle: "idle",
    unknown: "idle",
    thinking: "thinking",
    streaming: "responding",
    awaiting_approval: "awaiting-approval",
    compacting: "compacting",
    blocked: "failed",
  });
  const SAFE_CONTEXT_KEYS = new Set([
    "workspaceRelativePath",
    "displayPath",
    "pathCategory",
    "artifactKind",
    "fileKind",
    "extension",
  ]);
  const MAX_VOICE_LANES = 4;
  const SECONDARY_VOICE_GAIN = 0.62;
  const MAX_PROCESSED_EVENT_KEYS = 256;
  const COMPOSER_DRAFT_MIN_INTERVAL_MS = 120;
  const MAX_DRAFT_LENGTH = 4000;

  let prefs = { ...DEFAULT_PREFS };
  let loaded = false;
  let engine = null;
  let conductor = null;
  let lastSignature = null;
  let lastSessionKey = null;
  let lastServerKey = null;
  let processedEventKeys = new Set();
  let processedEventOrder = [];
  let lastComposerDraftAt = 0;
  let lastComposerDraftLength = 0;
  let visualMetrics = deriveVisualMetrics("idle", null, DEFAULT_PREFS.scene);
  let voiceLanes = [];
  const listeners = new Set();

  async function init(options = {}) {
    const storedPrefs = await readPrefs();
    prefs = normalizePrefs(storedPrefs);
    loaded = true;
    if (hasLegacyModePrefs(storedPrefs) || hasLegacyDefaultScene(storedPrefs)) {
      await persistPrefs(prefs);
    }
    notify();
    attachVisibilityHandler(options.document || globalThis.document);
    return getStatus();
  }

  function getStatus() {
    const preferredEngine = prefs.engine === "strudel" ? "strudel" : "native";
    return {
      loaded,
      enabled: Boolean(prefs.enabled),
      muted: Boolean(prefs.muted),
      volume: boundedVolume(prefs.volume),
      engine: engine?.kind || preferredEngine,
      preferredEngine,
      scene: normalizeScene(prefs.scene),
      started: Boolean(engine?.started),
      audible: Boolean(engine?.started && prefs.enabled && !prefs.muted),
      bedActive: Boolean(engine?.started && prefs.enabled && !prefs.muted && engine?.isBedActive?.()),
      state: engine?.state || "idle",
      profile: engine?.profile || null,
      visual: engine?.visualMetrics || visualMetrics,
      voices: voiceLanes.map(publicVoiceLane),
    };
  }

  function onChange(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function enableFromUserGesture() {
    prefs = normalizePrefs({ ...prefs, enabled: true, muted: false });
    await persistPrefs(prefs);
    let active = ensureEngine();
    if (active) {
      active.setScene(prefs.scene);
      const started = await active.start();
      if (!started && active.kind === "strudel") {
        active.destroy?.();
        engine = null;
        active = createNativeFallback();
        if (active) {
          active.setScene(prefs.scene);
          await active.start();
        }
      }
      active.setVolume(prefs.volume);
      active.setMuted(false);
      const brain = ensureConductor(active.profile);
      brain.start();
      applyConductorState(brain.getState(), { accent: false });
    }
    notify();
    return getStatus();
  }

  async function disable() {
    prefs = normalizePrefs({ ...prefs, enabled: false });
    await persistPrefs(prefs);
    lastSignature = null;
    resetProcessedEvents();
    lastComposerDraftAt = 0;
    lastComposerDraftLength = 0;
    if (engine) {
      engine.setState("idle", engine.profile, { accent: false });
      engine.stopScoreLoop();
      engine.applyGain(0);
      engine.destroy?.();
      engine = null;
    }
    disposeConductor();
    notify();
    return getStatus();
  }

  async function setMuted(muted) {
    prefs = normalizePrefs({ ...prefs, muted: Boolean(muted) });
    await persistPrefs(prefs);
    if (engine) engine.setMuted(prefs.muted);
    notify();
    return getStatus();
  }

  async function setVolume(volume) {
    prefs = normalizePrefs({ ...prefs, volume });
    await persistPrefs(prefs);
    if (engine) engine.setVolume(prefs.volume);
    notify();
    return getStatus();
  }

  async function setMode() {
    prefs = normalizePrefs(prefs);
    await persistPrefs(prefs);
    notify();
    return getStatus();
  }

  async function setScene(scene) {
    prefs = normalizePrefs({ ...prefs, scene });
    await persistPrefs(prefs);
    if (conductor) conductor.setScene(prefs.scene);
    if (engine) engine.setScene(prefs.scene);
    if (engine?.profile && engine.context) {
      engine.configureBed(engine.state, engine.profile);
      engine.refreshVisualMetrics();
    } else if (engine?.profile && typeof engine.refreshVisualMetrics === "function") {
      engine.refreshVisualMetrics();
    } else {
      visualMetrics = deriveVisualMetrics("idle", null, prefs.scene);
    }
    notify();
    return getStatus();
  }

  async function testAccent() {
    const active = ensureEngine();
    if (!active?.started) return getStatus();
    active.playAccent("soft", active.profile || deriveVibeProfile(), 0.45);
    notify();
    return getStatus();
  }

  async function toggleFromUserGesture() {
    if (prefs.enabled && engine?.started && !prefs.muted) {
      return disable();
    }
    return enableFromUserGesture();
  }

  function syncSnapshot(snapshot, context = {}) {
    if (!loaded || !prefs.enabled || prefs.muted) {
      return getStatus();
    }

    const selection = selectSession(snapshot);
    if (!selection.session) {
      silence("no-session");
      return getStatus();
    }

    const serverKey = clean(snapshot?.serverId ?? snapshot?.server?.id ?? snapshot?.query?.server);
    const sessionKey = sessionIdentity(selection.session);
    if (lastServerKey && serverKey && serverKey !== lastServerKey) {
      silence("server-changed");
    }
    if (lastSessionKey && sessionKey && sessionKey !== lastSessionKey) {
      lastSignature = null;
    }
    lastServerKey = serverKey || lastServerKey;
    lastSessionKey = sessionKey || lastSessionKey;

    const state = resolveVibeState(selection.session);
    const profile = deriveVibeProfile({
      snapshot,
      context,
      session: selection.session,
      event: latestLiveEvent(selection.session),
    });
    voiceLanes = buildSessionVoiceLanes(snapshot, context, selection.session);
    const active = ensureEngine();
    if (!active?.started) {
      return getStatus();
    }

    const liveEvents = liveEventsForSession(selection.session);
    const unseenEvents = selectUnseenLiveEvents(selection.session, liveEvents);
    const signature = buildSignature(selection.session, state, profile, voiceLanes);
    if (signature === lastSignature && unseenEvents.length === 0) {
      return getStatus();
    }

    lastSignature = signature;
    active.setScene(prefs.scene);
    active.setVolume(prefs.volume);
    active.setMuted(false);
    active.setVoices?.(voiceLanes);
    if (unseenEvents.length) {
      driveConductorEvents(state, profile, selection.session, unseenEvents);
    } else {
      driveConductor(state, profile, selection.session, latestLiveEvent(selection.session));
    }
    notify();
    return getStatus();
  }

  function syncComposerDraft(input = {}) {
    if (!loaded || !prefs.enabled || prefs.muted) {
      return getStatus();
    }

    const active = ensureEngine();
    if (!active?.started) {
      return getStatus();
    }

    const now = Date.now();
    const length = boundedDraftLength(input?.length);
    if (now - lastComposerDraftAt < COMPOSER_DRAFT_MIN_INTERVAL_MS && length === lastComposerDraftLength) {
      return getStatus();
    }

    const profile = active.profile || deriveVibeProfile({ context: input?.context || {} });
    const brain = ensureConductor(profile);
    brain.start();
    brain.push({
      kind: length > 0 ? "draft" : "stop",
      source: "composer",
      ts: now,
      length,
      delta: length - lastComposerDraftLength,
      raviState: length > 0 ? "thinking" : "idle",
      profileKey: profile?.key || null,
    });
    lastComposerDraftAt = now;
    lastComposerDraftLength = length;
    notify();
    return getStatus();
  }

  function silence(_reason = "unavailable") {
    lastSignature = null;
    resetProcessedEvents();
    lastComposerDraftAt = 0;
    lastComposerDraftLength = 0;
    disposeConductor();
    visualMetrics = deriveVisualMetrics("idle", null, prefs.scene);
    voiceLanes = [];
    if (engine) {
      engine.setVoices?.([]);
      engine.setState("idle", engine.profile, { accent: false });
    }
    notify();
  }

  function ensureEngine() {
    const preferred = prefs.engine === "strudel" ? "strudel" : "native";
    if (engine?.kind === preferred) return engine;
    if (engine?.kind === "native" && preferred === "strudel" && !isStrudelSandboxAvailable()) return engine;
    if (engine) {
      engine.destroy?.();
      engine = null;
    }
    engine = preferred === "strudel" ? new StrudelSandboxEngine() : new NativeVibesEngine();
    if (!engine.available && preferred === "strudel") {
      engine.destroy?.();
      engine = new NativeVibesEngine();
    }
    return engine.available ? engine : null;
  }

  function createNativeFallback() {
    engine = new NativeVibesEngine();
    return engine.available ? engine : null;
  }

  function isStrudelSandboxAvailable() {
    return Boolean(
      globalThis.chrome?.runtime?.getURL &&
        globalThis.document?.createElement &&
        globalThis.document?.body?.appendChild,
    );
  }

  function ensureConductor(profile = null) {
    if (!conductor) {
      conductor = new VibesConductor({
        scene: prefs.scene,
        profile,
        onState: applyConductorState,
      });
    }
    conductor.setScene(prefs.scene);
    if (profile) conductor.setProfile(profile);
    return conductor;
  }

  function disposeConductor() {
    conductor?.dispose();
    conductor = null;
  }

  function driveConductor(state, profile, session, event) {
    const brain = ensureConductor(profile);
    brain.start();
    brain.push(agentEventFromSessionState(state, session, event, profile));
  }

  function driveConductorEvents(state, profile, session, events) {
    const brain = ensureConductor(profile);
    brain.start();
    for (const event of events) {
      brain.push(agentEventFromSessionState(state, session, event, profile));
    }
  }

  function applyConductorState(musicalState, options = {}) {
    const visual = musicalStateToVisual(musicalState);
    visualMetrics = visual;
    const active = engine;
    if (active?.started) {
      const profile = conductor?.profile || active.profile || null;
      active.setScene(prefs.scene);
      active.setState(musicalState.raviState || musicalPhaseToRaviState(musicalState.phase), profile, {
        accent: Boolean(options.accent),
        visual,
      });
    }
    notify();
  }

  function agentEventFromSessionState(state, session, event, profile) {
    const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
    const kind = clean(event?.kind);
    const runtimeType = clean(metadata.type);
    const toolEvent = clean(metadata.event);
    const toolName = clean(metadata.toolName ?? metadata.tool ?? metadata.name);
    const rawTs = Number(event?.timestamp || event?.ts || Date.now()) || Date.now();
    const ts = rawTs > 1_000_000_000_000 ? rawTs : Date.now();
    const base = {
      source: "runtime",
      ts,
      tool: toolName || undefined,
      category: categorizeVibesTool(toolName),
      raviState: state,
      profileKey: profile?.key || null,
    };

    if (kind === "tool") {
      if (toolEvent === "end" && (metadata.isError || metadata.error || metadata.status === "failed")) {
        return { ...base, kind: "tool-fail", raviState: "failed" };
      }
      return { ...base, kind: "tool", raviState: "tooling" };
    }
    if (kind === "stream" || kind === "response") {
      return { ...base, kind: "response", raviState: "responding" };
    }
    if (kind === "runtime") {
      if (runtimeType === "prompt.received" || runtimeType === "dispatch.queued") {
        return { ...base, kind: "prompt", raviState: runtimeType === "dispatch.queued" ? "queued" : "thinking" };
      }
      if (runtimeType === "turn.interrupt.requested") {
        return { ...base, kind: "tool-fail", raviState: "interrupted" };
      }
      if (runtimeType === "turn.failed" || runtimeType === "provider.inactive" || runtimeType === "tool.stuck") {
        return { ...base, kind: "tool-fail", raviState: "failed" };
      }
      if (runtimeType === "turn.complete" || runtimeType === "turn.interrupted" || runtimeType === "silent") {
        return {
          ...base,
          kind: runtimeType === "turn.interrupted" ? "tool-fail" : "stop",
          raviState: runtimeType === "turn.interrupted" ? "interrupted" : "idle",
        };
      }
      if (runtimeType === "status") {
        const status = clean(metadata.status);
        if (status === "idle") return { ...base, kind: "stop", raviState: "idle" };
        if (status === "queued") return { ...base, kind: "prompt", raviState: "queued" };
        if (status === "thinking" || status === "compacting") return { ...base, kind: "thought", raviState: status };
      }
      if (runtimeType === "runtime.control" || runtimeType === "skill.visibility.loaded" || runtimeType === "task.runtime.release") {
        return { ...base, kind: "thought", raviState: "thinking" };
      }
      const deliveryStatus = clean(metadata.status);
      if (deliveryStatus === "delivered") {
        return { ...base, kind: "response", raviState: "responding" };
      }
      if (deliveryStatus === "failed" || deliveryStatus === "dropped") {
        return { ...base, kind: "tool-fail", raviState: "failed" };
      }
    }

    switch (state) {
      case "queued":
        return { ...base, kind: "prompt", raviState: "queued" };
      case "thinking":
      case "compacting":
        return { ...base, kind: "thought", raviState: state };
      case "tooling":
        return { ...base, kind: "tool", raviState: "tooling" };
      case "responding":
        return { ...base, kind: "response", raviState: "responding" };
      case "failed":
      case "interrupted":
        return { ...base, kind: "tool-fail", raviState: state };
      default:
        return { ...base, kind: "stop", raviState: "idle" };
    }
  }

  function categorizeVibesTool(tool) {
    const value = clean(tool)?.toLowerCase();
    if (!value) return "other";
    if (/(read|grep|glob|search|find|fetch|list|open|get|view)/.test(value)) return "research";
    if (/(shell|bash|exec|command|terminal|await)/.test(value)) return "execute";
    if (/(write|edit|patch|replace|delete|move|create|insert|update)/.test(value)) return "build";
    if (/(todo|plan|task|checklist)/.test(value)) return "plan";
    if (/(mcp|tool_search|plugin|connector)/.test(value)) return "mcp";
    return "other";
  }

  function musicalStateToVisual(state) {
    const scene = normalizeScene(state?.scene);
    const intensity = clamp01(state?.intensity);
    const tension = clamp01(state?.tension);
    const cps = Math.max(0.25, Math.min(1.2, Number(state?.cps) || 0.45));
    return {
      intensity,
      tension,
      cps,
      phase: clean(state?.phase) || "idle",
      activity: clamp01(state?.activity),
      voices: Math.max(1, Math.min(4, Number(state?.voices) || 1)),
      scene,
      sceneLabel: SCENE_CONFIG[scene]?.label || scene,
      accent: SCENE_CONFIG[scene]?.accent || "#ff8a3d",
      accent2: SCENE_CONFIG[scene]?.accent2 || "#4a90d9",
      signalLevel: Math.max(intensity, tension * 0.85, clamp01(state?.activity) * 0.55),
      key: cleanMusicKey(state?.key),
      scaleMode: cleanScaleMode(state?.mode, scene),
      rev: Number(state?.rev) || 0,
    };
  }

  function musicalPhaseToRaviState(phase) {
    switch (phase) {
      case "prompting":
      case "thinking":
        return "thinking";
      case "working":
        return "tooling";
      case "drop":
        return "responding";
      case "resolve":
        return "idle";
      default:
        return "idle";
    }
  }

  class VibesConductor {
    constructor(options) {
      this.tickMs = Number(options?.tickMs) || 100;
      this.onState = typeof options?.onState === "function" ? options.onState : () => {};
      this.scene = normalizeScene(options?.scene);
      this.profile = options?.profile || null;
      this.seed = seedNumberFromProfile(this.profile, this.scene);
      const [cpsMin] = cpsRange(this.scene);
      this.state = {
        scene: this.scene,
        phase: "idle",
        raviState: "idle",
        intensity: 0.12,
        tension: 0,
        cps: cpsMin,
        activity: 0,
        voices: 1,
        seed: this.seed,
        key: keyForSeed(this.seed),
        mode: modeForSeed(this.seed, this.scene),
        rev: 0,
      };
      this.targets = {
        intensity: this.state.intensity,
        tension: 0,
        cps: this.state.cps,
      };
      this.recentEvents = [];
      this.lastEventAt = Date.now();
      this.lastDraftLen = 0;
      this.lastDraftAt = 0;
      this.timer = null;
    }

    start() {
      if (this.timer || typeof globalThis.setInterval !== "function") {
        this.emit(false);
        return;
      }
      this.timer = globalThis.setInterval(() => this.tick(false), this.tickMs);
      this.emit(false);
    }

    dispose() {
      if (this.timer && typeof globalThis.clearInterval === "function") {
        globalThis.clearInterval(this.timer);
      }
      this.timer = null;
    }

    getState() {
      return { ...this.state };
    }

    setScene(scene) {
      const nextScene = normalizeScene(scene);
      if (nextScene === this.scene) return;
      this.scene = nextScene;
      this.state.scene = nextScene;
      this.seed = seedNumberFromProfile(this.profile, this.scene);
      this.state.seed = this.seed;
      this.state.key = keyForSeed(this.seed);
      this.state.mode = modeForSeed(this.seed, this.scene);
      const [cpsMin] = cpsRange(this.scene);
      this.targets.cps = Math.max(this.targets.cps, cpsMin);
      this.emit(false);
    }

    setProfile(profile) {
      const key = profile?.key || null;
      if (key === this.profile?.key) return;
      this.profile = profile || null;
      this.seed = seedNumberFromProfile(this.profile, this.scene);
      this.state.seed = this.seed;
      this.state.key = keyForSeed(this.seed);
      this.state.mode = modeForSeed(this.seed, this.scene);
      this.emit(false);
    }

    push(event) {
      const ev = event && typeof event === "object" ? event : { kind: "stop", ts: Date.now() };
      const now = Number(ev.ts) || Date.now();
      this.lastEventAt = now;
      this.state.raviState = ev.raviState || this.state.raviState || "idle";
      const [cpsMin, cpsMax] = cpsRange(this.scene);

      switch (ev.kind) {
        case "session-start":
          this.setPhase("idle");
          this.targets.intensity = 0.12;
          this.targets.tension = 0;
          break;
        case "prompt":
          this.setPhase("prompting");
          this.bump("intensity", 0.18);
          this.targets.intensity = Math.max(this.targets.intensity, 0.3);
          break;
        case "thought":
          this.setPhase("thinking");
          this.bump("intensity", 0.06);
          break;
        case "tool":
          this.setPhase("working");
          this.recentEvents.push(now);
          if (ev.category === "build") this.bump("intensity", 0.14);
          else if (ev.category === "execute") this.bump("intensity", 0.08);
          else if (ev.category === "research") this.bump("intensity", 0.05);
          else if (ev.category === "plan") this.bump("intensity", 0.04);
          else this.bump("intensity", 0.05);
          this.targets.cps = clamp(this.targets.cps + 0.01, cpsMin, cpsMax);
          break;
        case "tool-fail":
          this.bump("tension", 0.35);
          this.bump("intensity", 0.05);
          break;
        case "subagent-start":
          this.state.voices = Math.min(4, this.state.voices + 1);
          this.bump("intensity", 0.08);
          break;
        case "subagent-stop":
          this.state.voices = Math.max(1, this.state.voices - 1);
          break;
        case "response":
          this.setPhase("drop");
          this.targets.intensity = Math.max(this.targets.intensity, 0.9);
          this.targets.cps = clamp(cpsMax, cpsMin, cpsMax);
          break;
        case "typing":
          this.recentEvents.push(now);
          if (ev.source === "composer") {
            this.setPhase("prompting");
            this.bump("intensity", 0.028);
          } else {
            this.bump("intensity", 0.015);
          }
          break;
        case "draft": {
          this.setPhase("prompting");
          this.recentEvents.push(now);
          const len = Math.max(0, Math.min(MAX_DRAFT_LENGTH, Number(ev.length) || 0));
          const floor = clamp(0.2 + (len / 600) * 0.4, 0.2, 0.7);
          this.targets.intensity = Math.max(this.targets.intensity, floor);
          const dt = this.lastDraftAt ? now - this.lastDraftAt : 0;
          const dChars = Number.isFinite(Number(ev.delta)) ? Number(ev.delta) : len - this.lastDraftLen;
          if (dt > 0 && dChars > 0) {
            const charsPerSecond = dChars / (dt / 1000);
            this.targets.cps = clamp(this.targets.cps + Math.min(0.025, charsPerSecond * 0.0015), cpsMin, cpsMax);
            this.bump("intensity", clamp(charsPerSecond * 0.003, 0, 0.06));
          }
          this.lastDraftLen = len;
          this.lastDraftAt = now;
          break;
        }
        case "stop":
        default:
          this.setPhase("resolve");
          this.targets.intensity = 0.18;
          this.targets.tension = 0;
          break;
      }
      this.tick(true);
    }

    setPhase(phase) {
      this.state.phase = phase;
    }

    bump(field, amount) {
      this.targets[field] = clamp(this.targets[field] + amount, 0, 1);
    }

    tick(accent) {
      const now = Date.now();
      const sinceEvent = now - this.lastEventAt;
      this.recentEvents = this.recentEvents.filter((time) => now - time < 6000);
      this.state.activity = clamp(this.recentEvents.length / 8, 0, 1);

      if (sinceEvent > 4000 && (this.state.phase === "working" || this.state.phase === "thinking")) {
        this.targets.tension = clamp(this.targets.tension + 0.004, 0, 0.7);
      } else {
        this.targets.tension = clamp(this.targets.tension - 0.01, 0, 1);
      }
      if (sinceEvent > 2500) {
        this.targets.intensity = clamp(this.targets.intensity - 0.006, 0.1, 1);
        const [cpsMin] = cpsRange(this.scene);
        this.targets.cps = clamp(this.targets.cps - 0.004, cpsMin, this.targets.cps);
      }
      if (sinceEvent > 12000 && this.state.phase !== "idle") {
        this.setPhase("idle");
        this.state.raviState = "idle";
      }

      const k = 0.12;
      this.state.intensity = lerp(this.state.intensity, this.targets.intensity, k);
      this.state.tension = lerp(this.state.tension, this.targets.tension, k);
      this.state.cps = lerp(this.state.cps, this.targets.cps, k * 0.6);
      this.emit(Boolean(accent));
    }

    emit(accent) {
      this.state.rev += 1;
      this.onState({ ...this.state }, { accent });
    }
  }

  function cpsRange(scene) {
    return CPS_RANGE_BY_SCENE[normalizeScene(scene)] || CPS_RANGE_BY_SCENE.cinematic;
  }

  function seedNumberFromProfile(profile, scene) {
    const seedText = [profile?.key, profile?.chatBucket, profile?.sessionBucket, scene].filter(Boolean).join("|") || scene;
    return hashString(seedText);
  }

  function keyForSeed(seed) {
    return MUSIC_KEYS[Math.abs(Number(seed) || 0) % MUSIC_KEYS.length] || "c";
  }

  function modeForSeed(seed, scene) {
    const modes = SCALE_MODES_BY_SCENE[normalizeScene(scene)] || SCALE_MODES_BY_SCENE.cinematic;
    return modes[Math.abs(Number(seed) || 0) % modes.length] || "minor";
  }

  function cleanMusicKey(value) {
    return MUSIC_KEYS.includes(value) ? value : "c";
  }

  function cleanScaleMode(value, scene) {
    const modes = SCALE_MODES_BY_SCENE[normalizeScene(scene)] || SCALE_MODES_BY_SCENE.cinematic;
    return modes.includes(value) ? value : modes[0];
  }

  function clamp(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.max(min, Math.min(max, numeric));
  }

  function lerp(a, b, k) {
    return a + (b - a) * k;
  }

  function selectSession(snapshot) {
    const direct = snapshot?.session && typeof snapshot.session === "object" ? snapshot.session : null;
    if (direct) return { session: direct, source: "selected" };

    const active = [
      ...(Array.isArray(snapshot?.activeSessions) ? snapshot.activeSessions : []),
      ...(Array.isArray(snapshot?.hotSessions) ? snapshot.hotSessions : []),
    ].find((session) => isLiveActive(session?.live?.activity));

    if (active) return { session: active, source: "active" };
    return { session: null, source: "none" };
  }

  function buildSessionVoiceLanes(snapshot, context, primarySession) {
    const primaryId = sessionIdentity(primarySession);
    const sessions = [];
    const seen = new Set();
    const add = (session) => {
      if (!session || typeof session !== "object") return;
      const id = sessionIdentity(session);
      if (!id || seen.has(id)) return;
      seen.add(id);
      sessions.push(session);
    };

    add(primarySession);
    (Array.isArray(snapshot?.activeSessions) ? snapshot.activeSessions : []).forEach(add);
    (Array.isArray(snapshot?.hotSessions) ? snapshot.hotSessions : []).forEach(add);
    (Array.isArray(snapshot?.recentSessions) ? snapshot.recentSessions : []).forEach(add);
    (Array.isArray(snapshot?.recentChats) ? snapshot.recentChats : []).forEach(add);

    return sessions
      .map((session) => buildSessionVoiceLane(snapshot, context, session, sessionIdentity(session) === primaryId))
      .filter((voice) => voice.role === "primary" || ACTIVE_STATES.has(voice.state) || EDGE_ACCENT_STATES.has(voice.state))
      .sort((a, b) => voicePriority(b) - voicePriority(a))
      .slice(0, MAX_VOICE_LANES)
      .map((voice, index) => normalizeVoiceLane({ ...voice, index }));
  }

  function buildSessionVoiceLane(snapshot, context, session, primary) {
    const state = resolveVibeState(session);
    const event = latestLiveEvent(session);
    const profile = deriveVibeProfile({ snapshot, context, session, event });
    const visual = deriveVisualMetrics(state, profile, prefs.scene);
    const updatedAt = sessionUpdatedAt(session);
    const indexSeed = hashString(sessionIdentity(session));
    const role = primary ? "primary" : "secondary";
    const pan = primary ? Number(profile.pan) || 0 : secondaryPan(indexSeed);
    return {
      id: profile.key,
      role,
      label: sessionVoiceLabel(session, profile),
      provider: profile.provider || null,
      modelBucket: profile.modelBucket || null,
      pathBucket: profile.pathBucket || null,
      extension: profile.extension || null,
      state,
      phase: visual.phase,
      intensity: visual.intensity,
      tension: visual.tension,
      cps: visual.cps,
      activity: visual.activity,
      gain: primary ? 1 : secondaryGain(state, visual),
      pan,
      seed: profile.key,
      key: visual.key,
      scaleMode: visual.scaleMode,
      accent: visual.accent,
      accent2: visual.accent2,
      updatedAt,
      profile,
    };
  }

  function normalizeVoiceLane(voice) {
    const role = voice?.role === "primary" ? "primary" : "secondary";
    const state = ACTIVE_STATES.has(voice?.state) || EDGE_ACCENT_STATES.has(voice?.state) ? voice.state : "idle";
    return {
      id: clean(voice?.id) || `v${hashString(`${role}-${voice?.index || 0}`).toString(36)}`,
      role,
      label: shortVoiceLabel(voice?.label || role),
      provider: shortVoiceLabel(voice?.provider || ""),
      modelBucket: clean(voice?.modelBucket),
      pathBucket: clean(voice?.pathBucket),
      extension: clean(voice?.extension),
      state,
      phase: clean(voice?.phase) || stateToPhase(state),
      intensity: clamp01(voice?.intensity),
      tension: clamp01(voice?.tension),
      cps: Math.max(0.25, Math.min(1.2, Number(voice?.cps) || 0.5)),
      activity: clamp01(voice?.activity),
      gain: role === "primary" ? 1 : clamp(Number(voice?.gain), 0, 0.7),
      pan: clamp(Number(voice?.pan), -0.75, 0.75),
      seed: cleanStrudelSeed(voice?.seed),
      key: cleanMusicKey(voice?.key),
      scaleMode: cleanScaleMode(voice?.scaleMode, prefs.scene),
      accent: clean(voice?.accent) || SCENE_CONFIG[prefs.scene]?.accent || "#ff8a3d",
      accent2: clean(voice?.accent2) || SCENE_CONFIG[prefs.scene]?.accent2 || "#4a90d9",
      updatedAt: Number(voice?.updatedAt) || 0,
      index: Number(voice?.index) || 0,
      profile: voice?.profile || null,
    };
  }

  function publicVoiceLane(voice) {
    return {
      id: voice.id,
      role: voice.role,
      label: voice.label,
      provider: voice.provider || null,
      state: voice.state,
      phase: voice.phase,
      intensity: voice.intensity,
      tension: voice.tension,
      activity: voice.activity,
      gain: voice.gain,
      pan: voice.pan,
      key: voice.key,
      scaleMode: voice.scaleMode,
      accent: voice.accent,
      accent2: voice.accent2,
    };
  }

  function sandboxVoiceLane(voice) {
    return {
      role: voice.role,
      state: voice.state,
      seed: cleanStrudelSeed(voice.seed),
      key: cleanMusicKey(voice.key),
      scaleMode: cleanScaleMode(voice.scaleMode, prefs.scene),
      intensity: clamp01(voice.intensity),
      tension: clamp01(voice.tension),
      gain: voice.role === "primary" ? 1 : clamp(Number(voice.gain), 0, 0.7),
      pan: clamp(Number(voice.pan), -0.75, 0.75),
      phase: clean(voice.phase) || stateToPhase(voice.state),
    };
  }

  function sandboxAudioVoices(voices) {
    if (!Array.isArray(voices) || voices.length === 0) return [];
    const primary = voices.find((voice) => voice.role === "primary") || voices[0];
    return primary ? [sandboxVoiceLane({ ...primary, role: "primary", gain: 1 })] : [];
  }

  function voicePriority(voice) {
    const role = voice.role === "primary" ? 1_000_000 : 0;
    const state = ACTIVE_STATES.has(voice.state) ? 100_000 : EDGE_ACCENT_STATES.has(voice.state) ? 80_000 : 0;
    return role + state + (Number(voice.updatedAt) || 0);
  }

  function secondaryGain(state, visual) {
    const base = {
      queued: 0.2,
      thinking: 0.38,
      tooling: 0.58,
      responding: 0.62,
      "awaiting-approval": 0.48,
      compacting: 0.24,
      failed: 0.56,
      interrupted: 0.42,
      idle: 0,
    }[state] || 0;
    return clamp(base * (0.72 + clamp01(visual?.intensity) * 0.55), 0, SECONDARY_VOICE_GAIN);
  }

  function secondaryPan(seed) {
    const bucket = Math.abs(Number(seed) || 0) % 7;
    return [-0.66, 0.66, -0.38, 0.38, -0.18, 0.18, 0][bucket] || 0;
  }

  function sessionUpdatedAt(session) {
    const live = session?.live && typeof session.live === "object" ? session.live : {};
    const candidates = [live.updatedAt, session?.lastActivityAt, session?.updatedAt, session?.createdAt];
    for (const value of candidates) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return 0;
  }

  function sessionVoiceLabel(session, profile) {
    return shortVoiceLabel(
      clean(session?.sessionName ?? session?.name ?? session?.sessionKey) ||
        clean(session?.agentId) ||
        clean(profile?.provider) ||
        "session",
    );
  }

  function shortVoiceLabel(value) {
    const text = clean(value);
    if (!text) return "";
    return text.replace(/\s+/g, " ").slice(0, 22);
  }

  function isLiveActive(activity) {
    const state = SAFE_STATE_BY_ACTIVITY[clean(activity) || "idle"] || "idle";
    return state !== "idle";
  }

  function resolveVibeState(session) {
    const live = session?.live && typeof session.live === "object" ? session.live : {};
    const event = latestLiveEvent(session);
    const activity = clean(live.activity) || "idle";
    if (activity === "thinking" && event?.kind === "tool" && event?.metadata?.event !== "end") {
      return "tooling";
    }
    if (activity === "thinking" && clean(event?.metadata?.type) === "dispatch.queued") {
      return "queued";
    }
    if (activity === "thinking" && clean(event?.metadata?.status) === "queued") {
      return "queued";
    }
    return SAFE_STATE_BY_ACTIVITY[activity] || "idle";
  }

  function latestLiveEvent(session) {
    const events = liveEventsForSession(session);
    return events.find((event) => event && typeof event === "object") || null;
  }

  function liveEventsForSession(session) {
    return Array.isArray(session?.live?.events)
      ? session.live.events.filter((event) => event && typeof event === "object")
      : [];
  }

  function deriveVibeProfile(input = {}) {
    const snapshot = input.snapshot || {};
    const context = input.context || {};
    const session = input.session || {};
    const event = input.event || null;
    const chatKey = clean(context.chatId ?? session.boundChatId ?? session.chatId ?? snapshot?.query?.chatId);
    const chatTitle = clean(context.title ?? session.boundTitle ?? snapshot?.query?.title);
    const sessionName = clean(session.sessionName ?? session.name ?? session.sessionKey);
    const agentId = clean(session.agentId);
    const provider = clean(session.effectiveProvider ?? session.provider ?? session.agentProvider);
    const model = clean(session.model ?? session.modelOverride ?? session.agentModel);
    const safePath = extractSafePathContext(event?.metadata);
    const seed = [chatKey, chatTitle, sessionName, agentId, provider, model, safePath.bucket].filter(Boolean).join("|");
    const hash = hashString(seed || "ravi");
    const baseHz = 146 + (hash % 44);
    const color = (hash >>> 5) % 5;
    const pan = (((hash >>> 9) % 21) - 10) / 40;
    return {
      key: `v${hash.toString(36)}`,
      chatBucket: chatKey || chatTitle ? `chat-${(hashString(chatKey || chatTitle) % 997).toString(36)}` : null,
      sessionBucket: sessionName ? `session-${(hashString(sessionName) % 997).toString(36)}` : null,
      provider: provider || null,
      modelBucket: model ? `model-${(hashString(model) % 997).toString(36)}` : null,
      pathBucket: safePath.bucket,
      extension: safePath.extension,
      baseHz,
      color,
      pan,
    };
  }

  function extractSafePathContext(metadata) {
    if (!metadata || typeof metadata !== "object") return { bucket: null, extension: null };
    for (const key of SAFE_CONTEXT_KEYS) {
      const value = metadata[key];
      if (typeof value !== "string") continue;
      const safe = normalizeSafePathToken(value);
      if (safe) return safe;
    }
    return { bucket: null, extension: null };
  }

  function normalizeSafePathToken(value) {
    const raw = clean(value);
    if (!raw) return null;
    if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith("/") || raw.includes("..")) return null;
    if (/^[A-Za-z]:[\\/]/.test(raw)) return null;
    const normalized = raw.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (!parts.length) return null;
    const first = sanitizeBucket(parts.length > 1 ? parts[0] : "root");
    const file = parts[parts.length - 1] || "";
    const extMatch = file.match(/\.([a-z0-9]{1,12})$/i);
    const extension = extMatch ? extMatch[1].toLowerCase() : null;
    return {
      bucket: first ? `path-${first}-${(hashString(normalized) % 997).toString(36)}` : null,
      extension,
    };
  }

  function sanitizeBucket(value) {
    return clean(value)?.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || null;
  }

  function buildSignature(session, state, profile, voices = []) {
    const live = session?.live || {};
    const event = latestLiveEvent(session);
    const voiceSignature = voices
      .map((voice) => `${voice.id}:${voice.role}:${voice.state}:${Number(voice.updatedAt) || 0}:${voice.gain.toFixed(2)}`)
      .join(",");
    return [
      sessionIdentity(session),
      state,
      Number(live.updatedAt || 0),
      event?.kind || "",
      Number(event?.timestamp || 0),
      profile?.key || "",
      profile?.pathBucket || "",
      voiceSignature,
    ].join("|");
  }

  function selectUnseenLiveEvents(session, events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const selected = [];
    events.forEach((event) => {
      const key = liveEventKey(session, event);
      if (!key || processedEventKeys.has(key)) return;
      rememberProcessedEventKey(key);
      selected.push(event);
    });
    return selected.reverse();
  }

  function liveEventKey(session, event) {
    if (!event || typeof event !== "object") return null;
    const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
    return [
      sessionIdentity(session),
      clean(event.kind) || "event",
      Number(event.timestamp || event.ts || 0) || 0,
      clean(metadata.type) || "",
      clean(metadata.event) || "",
      clean(metadata.status) || "",
      clean(metadata.toolId ?? metadata.toolName ?? metadata.tool ?? metadata.name) || "",
    ].join("|");
  }

  function rememberProcessedEventKey(key) {
    processedEventKeys.add(key);
    processedEventOrder.push(key);
    while (processedEventOrder.length > MAX_PROCESSED_EVENT_KEYS) {
      const oldest = processedEventOrder.shift();
      if (oldest) processedEventKeys.delete(oldest);
    }
  }

  function resetProcessedEvents() {
    processedEventKeys = new Set();
    processedEventOrder = [];
  }

  function sessionIdentity(session) {
    return clean(session?.sessionName ?? session?.name ?? session?.sessionKey) || "unknown";
  }

  class StrudelSandboxEngine {
    constructor() {
      this.kind = "strudel";
      this.available = isStrudelSandboxAvailable();
      this.iframe = null;
      this.loadPromise = null;
      this.token = createMessageToken();
      this.started = false;
      this.muted = false;
      this.volume = DEFAULT_VOLUME;
      this.scene = DEFAULT_PREFS.scene;
      this.state = "idle";
      this.profile = null;
      this.visualMetrics = deriveVisualMetrics("idle", null, this.scene);
      this.voiceLanes = [];
      this.confirmed = false;
      this.startAck = null;
      this.startTimeout = null;
      this.lastError = null;
      this.messageHandler = (event) => this.handleSandboxMessage(event);
    }

    async start() {
      if (!this.available) return false;
      const frame = await this.ensureFrame();
      if (!frame?.contentWindow) return false;
      this.started = true;
      this.confirmed = false;
      this.lastError = null;
      const ack = this.waitForStartAck();
      this.postState("vibes.start");
      const ok = await ack;
      if (!ok) {
        this.post({ type: "vibes.stop" });
        this.started = false;
      }
      return ok;
    }

    async ensureFrame() {
      if (this.iframe?.contentWindow) return this.iframe;
      if (this.loadPromise) return this.loadPromise;
      this.attachMessageHandler();
      this.loadPromise = new Promise((resolve) => {
        try {
          const frame = globalThis.document.createElement("iframe");
          frame.src = globalThis.chrome.runtime.getURL("vibes-sandbox.html");
          frame.title = "Ravi vibes audio sandbox";
          frame.setAttribute("aria-hidden", "true");
          frame.setAttribute("tabindex", "-1");
          frame.allow = "autoplay";
          frame.style.position = "fixed";
          frame.style.width = "1px";
          frame.style.height = "1px";
          frame.style.opacity = "0";
          frame.style.pointerEvents = "none";
          frame.style.border = "0";
          frame.style.left = "-10px";
          frame.style.top = "-10px";
          frame.addEventListener(
            "load",
            () => {
              this.iframe = frame;
              this.post({ type: "vibes.init" });
              resolve(frame);
            },
            { once: true },
          );
          globalThis.document.body.appendChild(frame);
        } catch {
          resolve(null);
        }
      });
      return this.loadPromise;
    }

    attachMessageHandler() {
      if (this.messageAttached || typeof globalThis.addEventListener !== "function") return;
      globalThis.addEventListener("message", this.messageHandler);
      this.messageAttached = true;
    }

    handleSandboxMessage(event) {
      const msg = event?.data;
      if (!msg || typeof msg !== "object" || msg.source !== SANDBOX_SOURCE) return;
      if (this.iframe?.contentWindow && event?.source && event.source !== this.iframe.contentWindow) return;
      if (msg.type === "vibes.started") {
        this.confirmed = true;
        this.resolveStartAck(true);
        return;
      }
      if (msg.type === "vibes.error") {
        this.lastError = clean(msg.message) || "Strudel sandbox error";
        this.resolveStartAck(false);
      }
    }

    waitForStartAck(timeoutMs = 3000) {
      if (typeof globalThis.addEventListener !== "function" || typeof globalThis.setTimeout !== "function") {
        return Promise.resolve(true);
      }
      this.resolveStartAck(false);
      return new Promise((resolve) => {
        this.startAck = resolve;
        this.startTimeout = globalThis.setTimeout(() => this.resolveStartAck(false), timeoutMs);
      });
    }

    resolveStartAck(ok) {
      if (this.startTimeout && typeof globalThis.clearTimeout === "function") {
        globalThis.clearTimeout(this.startTimeout);
      }
      this.startTimeout = null;
      const resolve = this.startAck;
      this.startAck = null;
      resolve?.(Boolean(ok));
    }

    setVolume(volume) {
      this.volume = boundedVolume(volume);
      this.post({ type: "vibes.volume", volume: this.volume, muted: this.muted });
    }

    setMode() {
      this.postState("vibes.state");
    }

    setScene(scene) {
      this.scene = normalizeScene(scene);
      this.refreshVisualMetrics();
      this.postState("vibes.state");
    }

    setVoices(voices) {
      this.voiceLanes = Array.isArray(voices) ? voices.map(normalizeVoiceLane).slice(0, MAX_VOICE_LANES) : [];
      if (this.visualMetrics) {
        this.visualMetrics = { ...this.visualMetrics, voices: Math.max(1, this.voiceLanes.length || 1) };
        visualMetrics = this.visualMetrics;
      }
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      this.post({ type: "vibes.volume", volume: this.volume, muted: this.muted });
      if (!this.muted) this.postState("vibes.state");
    }

    setState(state, profile, options = {}) {
      const next = ACTIVE_STATES.has(state) || EDGE_ACCENT_STATES.has(state) ? state : "idle";
      this.state = next;
      this.profile = profile || this.profile || deriveVibeProfile();
      this.visualMetrics = normalizeVisualMetrics(options.visual, this.state, this.profile, this.scene);
      this.visualMetrics = { ...this.visualMetrics, voices: Math.max(1, this.voiceLanes.length || this.visualMetrics.voices || 1) };
      visualMetrics = this.visualMetrics;
      this.postState(options.accent ? "vibes.accent" : "vibes.state");
    }

    refreshVisualMetrics() {
      this.visualMetrics = deriveVisualMetrics(this.state, this.profile, this.scene);
      this.visualMetrics = { ...this.visualMetrics, voices: Math.max(1, this.voiceLanes.length || this.visualMetrics.voices || 1) };
      visualMetrics = this.visualMetrics;
    }

    isBedActive() {
      return this.started && !this.muted && this.volume > 0;
    }

    playAccent() {
      this.postState("vibes.accent");
    }

    stopScoreLoop() {
      this.post({ type: "vibes.stop" });
    }

    applyGain(value) {
      if (Number(value) <= 0) {
        this.post({ type: "vibes.stop" });
      } else {
        this.postState("vibes.state");
      }
    }

    postState(type) {
      if (!this.started || this.muted) {
        if (type !== "vibes.start") this.post({ type: "vibes.stop" });
        return;
      }
      this.post({
        type,
        state: this.state,
        scene: this.scene,
        seed: cleanStrudelSeed(this.profile?.key),
        key: cleanMusicKey(this.visualMetrics?.key),
        scaleMode: cleanScaleMode(this.visualMetrics?.scaleMode, this.scene),
        volume: this.volume,
        muted: this.muted,
        visual: this.visualMetrics,
        voices: sandboxAudioVoices(this.voiceLanes),
      });
    }

    post(message) {
      const target = this.iframe?.contentWindow;
      if (!target) return;
      try {
        target.postMessage({ ...message, token: this.token }, "*");
      } catch {
        // The audio layer is best effort.
      }
    }

    destroy() {
      this.post({ type: "vibes.stop" });
      this.resolveStartAck(false);
      this.started = false;
      this.loadPromise = null;
      if (this.messageAttached && typeof globalThis.removeEventListener === "function") {
        globalThis.removeEventListener("message", this.messageHandler);
      }
      this.messageAttached = false;
      try {
        this.iframe?.remove?.();
      } catch {
        // Ignore DOM teardown errors.
      }
      this.iframe = null;
    }
  }

  class NativeVibesEngine {
    constructor() {
      this.kind = "native";
      const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.AudioCtor = AudioCtor || null;
      this.available = Boolean(AudioCtor);
      this.context = null;
      this.master = null;
      this.bedGain = null;
      this.pan = null;
      this.oscillators = [];
      this.scoreTimer = null;
      this.scoreStep = 0;
      this.started = false;
      this.muted = false;
      this.volume = DEFAULT_VOLUME;
      this.scene = DEFAULT_PREFS.scene;
      this.state = "idle";
      this.profile = null;
      this.visualMetrics = deriveVisualMetrics("idle", null, this.scene);
      this.voiceLanes = [];
      this.lastAccentAt = new Map();
    }

    async start() {
      if (!this.available) return false;
      if (!this.context) this.createGraph();
      if (this.context?.state === "suspended") {
        await this.context.resume?.();
      }
      this.started = true;
      this.applyGain(0);
      this.syncScoreLoop(true);
      return true;
    }

    createGraph() {
      this.context = new this.AudioCtor();
      this.master = this.context.createGain();
      this.bedGain = this.context.createGain();
      this.master.gain.value = 0;
      this.bedGain.gain.value = 0;
      const destination = this.context.destination;
      if (typeof this.context.createStereoPanner === "function") {
        this.pan = this.context.createStereoPanner();
        this.bedGain.connect(this.pan);
        this.pan.connect(this.master);
      } else {
        this.bedGain.connect(this.master);
      }
      this.master.connect(destination);
      this.oscillators = [0, 1].map((index) => {
        const oscillator = this.context.createOscillator();
        oscillator.type = index === 0 ? "sine" : "triangle";
        oscillator.frequency.value = 160 * (index === 0 ? 1 : 1.5);
        oscillator.connect(this.bedGain);
        oscillator.start();
        return oscillator;
      });
    }

    setVolume(volume) {
      this.volume = boundedVolume(volume);
      this.applyGain(this.stateGain(this.state));
      this.syncScoreLoop();
    }

    setMode() {
      this.applyGain(this.stateGain(this.state));
      this.syncScoreLoop(true);
    }

    setScene(scene) {
      this.scene = normalizeScene(scene);
      this.refreshVisualMetrics();
    }

    setVoices(voices) {
      this.voiceLanes = Array.isArray(voices) ? voices.map(normalizeVoiceLane).slice(0, MAX_VOICE_LANES) : [];
      this.refreshVisualMetrics();
      this.syncScoreLoop();
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      this.applyGain(this.muted ? 0 : this.stateGain(this.state));
      this.syncScoreLoop();
    }

    setState(state, profile, options = {}) {
      if (!this.started || !this.context) return;
      const next = ACTIVE_STATES.has(state) || EDGE_ACCENT_STATES.has(state) ? state : "idle";
      const previous = this.state;
      this.state = next;
      this.profile = profile || this.profile || deriveVibeProfile();
      this.configureBed(next, this.profile);
      this.visualMetrics = normalizeVisualMetrics(options.visual, next, this.profile, this.scene);
      this.visualMetrics = { ...this.visualMetrics, voices: Math.max(1, this.voiceLanes.length || this.visualMetrics.voices || 1) };
      visualMetrics = this.visualMetrics;
      this.applyGain(this.muted ? 0 : this.stateGain(next));
      this.syncScoreLoop();
      if (options.accent && next !== previous) {
        this.playStateAccent(next, this.profile);
      }
    }

    configureBed(state, profile) {
      const now = this.context.currentTime || 0;
      const base = Number(profile?.baseHz) || 164;
      const sceneRatio = SCENE_CONFIG[this.scene]?.baseRatio || 1;
      const ratios = {
        idle: [1, 1.5],
        queued: [0.5, 1],
        thinking: [1, 1.5],
        tooling: [0.75, 1.25],
        responding: [1.5, 2],
        "awaiting-approval": [1, 2],
        compacting: [0.5, 0.75],
        failed: [0.5, 1.414],
        interrupted: [0.5, 1],
      }[state] || [1, 1.5];
      const types = {
        queued: ["sine", "triangle"],
        thinking: ["sine", "triangle"],
        tooling: ["triangle", "sawtooth"],
        responding: ["triangle", "sine"],
        "awaiting-approval": ["sine", "square"],
        compacting: ["triangle", "sine"],
      }[state] || ["sine", "triangle"];

      this.oscillators.forEach((oscillator, index) => {
        oscillator.type = types[index] || "sine";
        safeRamp(oscillator.frequency, base * sceneRatio * ratios[index], now, 0.18);
      });
      if (this.pan?.pan) {
        safeRamp(this.pan.pan, Number(profile?.pan) || 0, now, 0.2);
      }
    }

    stateGain(state) {
      if (!ACTIVE_STATES.has(state)) return 0.012 * this.volume;
      const gain = {
        queued: 0.018,
        thinking: 0.024,
        tooling: 0.028,
        responding: 0.026,
        "awaiting-approval": 0.024,
        compacting: 0.018,
      }[state] || 0;
      return gain * this.volume;
    }

    isBedActive() {
      return this.started && !this.muted && this.volume > 0;
    }

    refreshVisualMetrics() {
      this.visualMetrics = deriveVisualMetrics(this.state, this.profile, this.scene);
      this.visualMetrics = { ...this.visualMetrics, voices: Math.max(1, this.voiceLanes.length || this.visualMetrics.voices || 1) };
      visualMetrics = this.visualMetrics;
    }

    applyGain(value) {
      if (!this.context || !this.master || !this.bedGain) return;
      const now = this.context.currentTime || 0;
      const target = this.muted ? 0 : Math.max(0, Math.min(0.08, Number(value) || 0));
      safeRamp(this.master.gain, this.volume <= 0 ? 0 : 1, now, 0.08);
      safeRamp(this.bedGain.gain, target, now, 0.22);
    }

    syncScoreLoop(playNow = false) {
      const shouldRun = this.isBedActive() && Boolean(this.context);
      if (!shouldRun) {
        this.stopScoreLoop();
        return;
      }
      if (playNow) this.playScoreStep();
      if (this.scoreTimer || typeof globalThis.setTimeout !== "function") return;
      this.scoreTimer = globalThis.setTimeout(() => {
        this.scoreTimer = null;
        this.playScoreStep();
        this.syncScoreLoop();
      }, this.scoreStepMs());
    }

    stopScoreLoop() {
      if (!this.scoreTimer || typeof globalThis.clearTimeout !== "function") {
        this.scoreTimer = null;
        return;
      }
      globalThis.clearTimeout(this.scoreTimer);
      this.scoreTimer = null;
    }

    scoreStepMs() {
      const cps = Number(this.visualMetrics?.cps) || 0.48;
      return Math.max(160, Math.min(380, Math.round(420 - cps * 230)));
    }

    playScoreStep() {
      if (!this.context || this.muted || this.volume <= 0) return;
      const profile = this.profile || deriveVibeProfile();
      const state = this.state || "idle";
      const visual = this.visualMetrics || deriveVisualMetrics(state, profile, this.scene);
      const step = this.scoreStep;
      this.scoreStep = (this.scoreStep + 1) % 128;
      const note = scoreNoteForStep(this.scene, state, step, profile);
      const now = this.context.currentTime || 0;
      if (note) {
        this.playScoreTone(note.frequency, {
          type: note.type,
          start: now,
          duration: note.duration,
          gain: note.gain * this.volume * (0.72 + visual.intensity * 0.55),
          pan: note.pan,
        });
        if (note.harmony) {
          this.playScoreTone(note.harmony, {
            type: "sine",
            start: now + 0.012,
            duration: note.duration * 1.15,
            gain: note.gain * this.volume * 0.34,
            pan: -note.pan * 0.6,
          });
        }
      }
    }

    playScoreTone(frequency, options) {
      const osc = this.context.createOscillator();
      const gain = this.context.createGain();
      const panNode = typeof this.context.createStereoPanner === "function" ? this.context.createStereoPanner() : null;
      const start = options.start || this.context.currentTime || 0;
      const duration = Math.max(0.08, Math.min(0.75, Number(options.duration) || 0.18));
      const peak = Math.max(0, Math.min(0.035, Number(options.gain) || 0));
      osc.type = options.type || "triangle";
      osc.frequency.value = Math.max(40, Math.min(1800, Number(frequency) || 220));
      gain.gain.value = 0;
      if (panNode?.pan) {
        panNode.pan.value = Math.max(-0.65, Math.min(0.65, Number(options.pan) || 0));
        osc.connect(gain);
        gain.connect(panNode);
        panNode.connect(this.master);
      } else {
        osc.connect(gain);
        gain.connect(this.master);
      }
      safeRamp(gain.gain, peak, start, 0.018);
      safeRamp(gain.gain, peak * 0.45, start + duration * 0.35, duration * 0.18);
      safeRamp(gain.gain, 0, start + duration * 0.55, duration * 0.45);
      osc.start(start);
      osc.stop(start + duration + 0.08);
    }

    playStateAccent(state, profile) {
      if (state === "idle") return this.playAccent("done", profile, 0.7);
      if (state === "failed") return this.playAccent("failed", profile, 1);
      if (state === "interrupted") return this.playAccent("interrupted", profile, 0.8);
      if (state === "awaiting-approval") return this.playAccent("approval", profile, 0.8);
      if (state === "tooling") return this.playAccent("tooling", profile, 0.55);
      if (state === "responding") return this.playAccent("responding", profile, 0.4);
      return this.playAccent("soft", profile, 0.35);
    }

    playAccent(kind, profile, intensity = 0.5) {
      if (!this.context || this.muted || this.volume <= 0) return;
      const nowMs = Date.now();
      const cooldown = kind === "responding" ? 1400 : kind === "soft" ? 900 : 500;
      const last = this.lastAccentAt.get(kind) || 0;
      if (nowMs - last < cooldown) return;
      this.lastAccentAt.set(kind, nowMs);

      const now = this.context.currentTime || 0;
      const osc = this.context.createOscillator();
      const gain = this.context.createGain();
      const base = Number(profile?.baseHz) || 164;
      const freq = {
        done: base * 2,
        failed: base * 0.707,
        interrupted: base * 0.5,
        approval: base * 2.5,
        tooling: base * 1.25,
        responding: base * 2,
        soft: base * 1.5,
      }[kind] || base;
      osc.type = kind === "failed" ? "sawtooth" : kind === "tooling" ? "square" : "triangle";
      osc.frequency.value = freq;
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(this.master);
      safeRamp(gain.gain, Math.min(0.045, 0.14 * intensity * this.volume), now, 0.025);
      safeRamp(gain.gain, 0, now + 0.08, kind === "approval" ? 0.28 : 0.16);
      osc.start(now);
      osc.stop(now + (kind === "approval" ? 0.34 : 0.22));
    }

    destroy() {
      this.stopScoreLoop();
      this.applyGain(0);
      for (const oscillator of this.oscillators) {
        try {
          oscillator.stop?.();
        } catch {
          // Already stopped.
        }
      }
      this.oscillators = [];
      this.started = false;
      try {
        this.context?.close?.();
      } catch {
        // Some browser/fake contexts do not expose close.
      }
      this.context = null;
      this.master = null;
      this.bedGain = null;
      this.pan = null;
    }
  }

  function scoreNoteForStep(scene, state, step, profile) {
    const sceneId = normalizeScene(scene);
    const active = ACTIVE_STATES.has(state);
    const profileSeed = parseInt(String(profile?.key || "v0").replace(/^v/, ""), 36);
    const seed = Number.isFinite(profileSeed) ? profileSeed : 0;
    const base = (Number(profile?.baseHz) || 164) * (SCENE_CONFIG[sceneId]?.baseRatio || 1);
    const intensityBias = active ? 1 : 0;
    const scenePlan = {
      cinematic: {
        scale: [0, 3, 7, 10, 12, 15, 19],
        hits: active ? [0, 2, 4, 6] : [0, 4],
        type: "triangle",
        duration: active ? 0.34 : 0.48,
        gain: active ? 0.105 : 0.072,
      },
      techno: {
        scale: [0, 3, 5, 7, 10, 12, 15, 17],
        hits: active ? [0, 1, 3, 4, 6, 7] : [0, 2, 4, 6],
        type: "square",
        duration: 0.14,
        gain: active ? 0.085 : 0.058,
      },
      lofi: {
        scale: [0, 2, 3, 7, 9, 12, 14],
        hits: active ? [0, 3, 5] : [0, 5],
        type: "triangle",
        duration: active ? 0.28 : 0.38,
        gain: active ? 0.078 : 0.058,
      },
      chiptune: {
        scale: [0, 4, 7, 12, 16, 19, 24],
        hits: active ? [0, 1, 2, 4, 5, 7] : [0, 2, 4],
        type: "square",
        duration: 0.12,
        gain: active ? 0.074 : 0.052,
      },
      piano: {
        scale: [0, 3, 7, 12, 15, 19, 24],
        hits: active ? [0, 2, 5] : [0, 5],
        type: "sine",
        duration: active ? 0.42 : 0.58,
        gain: active ? 0.092 : 0.064,
      },
      jazz: {
        scale: [0, 3, 5, 7, 10, 14, 17],
        hits: active ? [0, 3, 4, 7] : [0, 4],
        type: "triangle",
        duration: active ? 0.24 : 0.36,
        gain: active ? 0.084 : 0.058,
      },
    }[sceneId];
    const stateDensity = {
      queued: 0,
      thinking: 1,
      tooling: 2,
      responding: 3,
      "awaiting-approval": 1,
      compacting: 0,
      failed: -1,
      interrupted: -1,
      idle: 0,
    }[state] || 0;
    const gridStep = step % 8;
    const hits = scenePlan.hits;
    if (!hits.includes(gridStep)) return null;
    const index = Math.abs(seed + step * (2 + intensityBias) + stateDensity) % scenePlan.scale.length;
    const octaveShift = sceneId === "techno" || sceneId === "chiptune" ? 12 : 0;
    const semitone = scenePlan.scale[index] + octaveShift + (state === "responding" && gridStep >= 4 ? 12 : 0);
    const frequency = semitoneToFrequency(base, semitone);
    const harmony = (sceneId === "cinematic" || sceneId === "piano" || sceneId === "jazz") && gridStep === 0
      ? semitoneToFrequency(base, semitone + (sceneId === "jazz" ? 10 : 7))
      : null;
    const pan = (((seed >>> 7) % 13) - 6) / 18 + (gridStep - 3.5) / 24;
    return {
      frequency,
      harmony,
      type: scenePlan.type,
      duration: scenePlan.duration,
      gain: scenePlan.gain,
      pan,
    };
  }

  function semitoneToFrequency(base, semitone) {
    return base * Math.pow(2, semitone / 12);
  }

  function safeRamp(audioParam, value, start, duration) {
    if (!audioParam) return;
    const target = Number.isFinite(value) ? value : 0;
    try {
      audioParam.cancelScheduledValues?.(start);
      audioParam.setValueAtTime?.(audioParam.value ?? 0, start);
      audioParam.linearRampToValueAtTime?.(target, start + duration);
      if (!audioParam.linearRampToValueAtTime) audioParam.value = target;
    } catch {
      audioParam.value = target;
    }
  }

  function attachVisibilityHandler(doc) {
    if (!doc?.addEventListener || doc.__raviVibesVisibilityAttached) return;
    doc.__raviVibesVisibilityAttached = true;
    doc.addEventListener("visibilitychange", () => {
      if (doc.hidden) silence("hidden");
    });
  }

  async function readPrefs() {
    if (globalThis.chrome?.storage?.local?.get) {
      return new Promise((resolve) => {
        try {
          globalThis.chrome.storage.local.get(STORAGE_KEY, (items) => {
            resolve(items?.[STORAGE_KEY] || null);
          });
        } catch {
          resolve(null);
        }
      });
    }
    return null;
  }

  async function persistPrefs(next) {
    const cleanPrefs = normalizePrefs(next);
    if (globalThis.chrome?.storage?.local?.set) {
      await new Promise((resolve) => {
        try {
          globalThis.chrome.storage.local.set({ [STORAGE_KEY]: cleanPrefs }, resolve);
        } catch {
          resolve();
        }
      });
      return;
    }
  }

  function normalizePrefs(value) {
    const source = value && typeof value === "object" ? value : {};
    const scene = hasLegacyDefaultScene(source) ? DEFAULT_PREFS.scene : normalizeScene(source.scene);
    return {
      enabled: Boolean(source.enabled),
      muted: Boolean(source.muted),
      volume: boundedVolume(source.volume ?? DEFAULT_PREFS.volume),
      engine: normalizeEngine(source.engine),
      scene,
      sceneDefaultVersion: DEFAULT_SCENE_VERSION,
      accentChatEvents: Boolean(source.accentChatEvents),
    };
  }

  function hasLegacyModePrefs(value) {
    return Boolean(value && typeof value === "object" && ("mode" in value || "modeExplicit" in value));
  }

  function hasLegacyDefaultScene(value) {
    return Boolean(value && typeof value === "object" && Number(value.sceneDefaultVersion) !== DEFAULT_SCENE_VERSION);
  }

  function boundedVolume(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_VOLUME;
    return Math.max(0, Math.min(0.3, numeric));
  }

  function boundedDraftLength(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.max(0, Math.min(MAX_DRAFT_LENGTH, Math.round(numeric)));
  }

  function normalizeEngine(value) {
    if (value === "native" || value === "strudel") return value;
    return DEFAULT_PREFS.engine;
  }

  function normalizeScene(value) {
    return SCENE_IDS.includes(value) ? value : DEFAULT_PREFS.scene;
  }

  function normalizeVisualMetrics(value, state, profile, scene) {
    const fallback = deriveVisualMetrics(state, profile, scene);
    const source = value && typeof value === "object" ? value : {};
    const sceneId = normalizeScene(source.scene || scene);
    return {
      ...fallback,
      intensity: clamp01(source.intensity ?? fallback.intensity),
      tension: clamp01(source.tension ?? fallback.tension),
      cps: Math.max(0.25, Math.min(1.2, Number(source.cps ?? fallback.cps) || fallback.cps)),
      phase: clean(source.phase) || fallback.phase,
      activity: clamp01(source.activity ?? fallback.activity),
      voices: Math.max(1, Math.min(4, Number(source.voices ?? fallback.voices) || fallback.voices || 1)),
      scene: sceneId,
      sceneLabel: SCENE_CONFIG[sceneId]?.label || sceneId,
      accent: clean(source.accent) || SCENE_CONFIG[sceneId]?.accent || fallback.accent,
      accent2: clean(source.accent2) || SCENE_CONFIG[sceneId]?.accent2 || fallback.accent2,
      signalLevel: clamp01(source.signalLevel ?? fallback.signalLevel),
      key: cleanMusicKey(source.key ?? fallback.key),
      scaleMode: cleanScaleMode(source.scaleMode ?? fallback.scaleMode, sceneId),
      rev: Number(source.rev ?? fallback.rev) || 0,
    };
  }

  function deriveVisualMetrics(state, profile, scene) {
    const normalizedState = ACTIVE_STATES.has(state) || EDGE_ACCENT_STATES.has(state) ? state : "idle";
    const sceneId = normalizeScene(scene);
    const base = {
      idle: [0.08, 0.0, 0.42],
      queued: [0.24, 0.1, 0.48],
      thinking: [0.42, 0.18, 0.58],
      tooling: [0.68, 0.28, 0.72],
      responding: [0.82, 0.08, 0.8],
      "awaiting-approval": [0.52, 0.62, 0.54],
      compacting: [0.34, 0.22, 0.46],
      failed: [0.48, 0.92, 0.5],
      interrupted: [0.28, 0.72, 0.44],
    }[normalizedState] || [0.08, 0.0, 0.42];
    const seed = parseInt(String(profile?.key || "v0").replace(/^v/, ""), 36);
    const jitter = Number.isFinite(seed) ? (seed % 17) / 100 : 0;
    const tempoFloor = SCENE_CONFIG[sceneId]?.tempoFloor || 0.45;
    const intensity = clamp01(base[0] + jitter * 0.35);
    const tension = clamp01(base[1] + jitter * 0.2);
    const cps = clamp01(base[2] + tempoFloor * 0.18 + jitter * 0.25);
    return {
      intensity,
      tension,
      cps,
      phase: stateToPhase(normalizedState),
      voices: normalizedState === "tooling" ? 2 : normalizedState === "responding" ? 3 : 1,
      scene: sceneId,
      sceneLabel: SCENE_CONFIG[sceneId]?.label || sceneId,
      accent: SCENE_CONFIG[sceneId]?.accent || "#ff8a3d",
      accent2: SCENE_CONFIG[sceneId]?.accent2 || "#4a90d9",
      signalLevel: Math.max(intensity, tension * 0.85),
      key: keyForSeed(seedNumberFromProfile(profile, sceneId)),
      scaleMode: modeForSeed(seedNumberFromProfile(profile, sceneId), sceneId),
      activity: 0,
      rev: 0,
    };
  }

  function stateToPhase(state) {
    switch (state) {
      case "queued":
        return "queued";
      case "thinking":
      case "tooling":
      case "compacting":
        return "working";
      case "responding":
        return "drop";
      case "awaiting-approval":
        return "approval";
      case "failed":
      case "interrupted":
        return "alert";
      default:
        return "idle";
    }
  }

  function clamp01(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, numeric));
  }

  function notify() {
    const status = getStatus();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // UI listeners are best effort.
      }
    }
  }

  function clean(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function cleanStrudelSeed(value) {
    return typeof value === "string" && /^v[a-z0-9]{1,16}$/i.test(value) ? value : "v0";
  }

  function createMessageToken() {
    const random = typeof Uint32Array === "function" ? new Uint32Array(4) : [0, 0, 0, 0];
    try {
      globalThis.crypto?.getRandomValues?.(random);
    } catch {
      for (let index = 0; index < random.length; index += 1) {
        random[index] = Math.floor(Math.random() * 0xffffffff) >>> 0;
      }
    }
    return Array.from(random, (value) => value.toString(36)).join(".");
  }

  function hashString(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  globalThis.__RAVI_WA_VIBES__ = {
    init,
    getStatus,
    onChange,
    enableFromUserGesture,
    disable,
    setMuted,
    setVolume,
    setMode,
    setScene,
    testAccent,
    toggleFromUserGesture,
    syncSnapshot,
    syncComposerDraft,
    silence,
    _test: {
      deriveVibeProfile,
      extractSafePathContext,
      normalizeSafePathToken,
      resolveVibeState,
      selectSession,
      normalizePrefs,
      deriveVisualMetrics,
      SCENE_IDS,
      STORAGE_KEY,
    },
  };
})();
