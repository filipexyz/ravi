(function () {
  const SOURCE = "ravi-wa-vibes-sandbox";
  const STATE_IDS = new Set([
    "idle",
    "queued",
    "thinking",
    "tooling",
    "responding",
    "awaiting-approval",
    "compacting",
    "failed",
    "interrupted",
  ]);
  const SCENE_IDS = ["cinematic", "techno", "lofi", "chiptune", "piano", "jazz"];
  const PHASE_IDS = new Set(["idle", "prompting", "thinking", "working", "drop", "resolve", "queued", "approval", "alert"]);
  const KEY_IDS = ["c", "d", "e", "f", "g", "a"];
  const SCALE_MODES_BY_SCENE = {
    cinematic: ["minor", "dorian", "aeolian", "phrygian"],
    techno: ["minor", "phrygian", "locrian"],
    lofi: ["dorian", "major", "mixolydian", "lydian"],
    chiptune: ["major", "mixolydian", "lydian", "minor"],
    piano: ["minor", "aeolian", "dorian", "lydian"],
    jazz: ["dorian", "mixolydian", "aeolian", "lydian"],
  };
  const DEFAULT_VOLUME = 0.18;
  const MIN_EVAL_INTERVAL_MS = 700;

  let authToken = null;
  let audioReady = false;
  let strudelAudioContext = null;
  let playing = false;
  let muted = false;
  let volume = DEFAULT_VOLUME;
  let scene = "jazz";
  let state = "idle";
  let seed = "v0";
  let musicKey = "c";
  let scaleMode = "minor";
  let visual = defaultVisual();
  let voices = [];
  let lastCode = "";
  let lastEvalAt = 0;

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "vibes.init") {
      acceptInit(msg);
      return;
    }
    if (!authToken || msg.token !== authToken) return;
    routeMessage(msg).catch((error) => report("vibes.error", { message: String(error?.message || error) }));
  });

  report("vibes.ready", {});

  function acceptInit(msg) {
    const token = cleanToken(msg.token);
    if (!token || authToken) return;
    authToken = token;
    report("vibes.ready", { initialized: true });
  }

  async function routeMessage(msg) {
    switch (msg.type) {
      case "vibes.start":
        applyPayload(msg);
        await startPlayback();
        break;
      case "vibes.state":
        applyPayload(msg);
        await applyPattern();
        break;
      case "vibes.volume":
        volume = boundedVolume(msg.volume);
        muted = Boolean(msg.muted);
        if (muted || volume <= 0) {
          stopPlayback();
        } else if (!playing) {
          await startPlayback();
        } else {
          await applyPattern(true);
        }
        break;
      case "vibes.accent":
        applyPayload(msg);
        await applyPattern(true);
        break;
      case "vibes.stop":
        stopPlayback();
        break;
      default:
        break;
    }
  }

  async function startPlayback() {
    const context = await ensureStrudelAudio();
    await Promise.resolve(context?.resume?.()).catch(() => {});
    if (context?.state === "suspended") {
      throw new Error("Strudel audio context suspended");
    }
    playing = true;
    await applyPattern(true);
    report("vibes.started", { contextState: context?.state || "unknown" });
  }

  async function ensureStrudelAudio() {
    if (!audioReady) {
      const init = getStrudel("initStrudel");
      if (typeof init !== "function") throw new Error("Strudel init unavailable");
      const context = createStrudelAudioContext();
      await Promise.resolve(context?.resume?.()).catch(() => {});
      await Promise.resolve(init(context ? { audioContext: context } : {}));
      const initAudio = getStrudel("initAudio");
      if (typeof initAudio === "function") {
        await Promise.resolve(initAudio({}));
      }
      audioReady = true;
    }
    return getAudioContext() || strudelAudioContext;
  }

  function createStrudelAudioContext() {
    if (strudelAudioContext) return strudelAudioContext;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioCtor !== "function") return null;
    try {
      strudelAudioContext = new AudioCtor();
      return strudelAudioContext;
    } catch {
      return null;
    }
  }

  function stopPlayback() {
    playing = false;
    lastCode = "";
    lastEvalAt = 0;
    try {
      getStrudel("hush")?.();
    } catch {
      // Best effort silence.
    }
    report("vibes.stopped", {});
  }

  async function applyPattern(force = false) {
    if (!playing || muted || volume <= 0) {
      stopPlayback();
      return;
    }
    const code = buildPattern({
      scene,
      state,
      seed,
      key: musicKey,
      scaleMode,
      intensity: visual.intensity,
      tension: visual.tension,
      cps: visual.cps,
      phase: visual.phase,
      volume,
      voices,
    });
    const now = Date.now();
    if (!force && now - lastEvalAt < MIN_EVAL_INTERVAL_MS) return;
    if (!force && code === lastCode) return;
    lastCode = code;
    lastEvalAt = now;
    const evaluate = getStrudel("evaluate");
    if (typeof evaluate !== "function") throw new Error("Strudel evaluate unavailable");
    await Promise.resolve(evaluate(code));
  }

  function applyPayload(msg) {
    state = normalizeState(msg.state);
    scene = normalizeScene(msg.scene);
    volume = boundedVolume(msg.volume);
    muted = Boolean(msg.muted);
    seed = cleanSeed(msg.seed) || seed;
    musicKey = cleanKey(msg.key) || keyFromSeed(seed);
    scaleMode = cleanScaleMode(msg.scaleMode, scene) || modeFromSeed(seed, scene);
    visual = normalizeVisual(msg.visual, state, scene);
    voices = normalizeVoices(msg.voices, state, scene);
  }

  function getStrudel(name) {
    return window[name] || window.strudel?.[name] || null;
  }

  function getAudioContext() {
    try {
      const getter = getStrudel("getAudioContext");
      return typeof getter === "function" ? getter() : null;
    } catch {
      return null;
    }
  }

  function report(type, data) {
    try {
      window.parent?.postMessage({ source: SOURCE, type, ...data }, "*");
    } catch {
      // Diagnostics only.
    }
  }

  function cleanToken(value) {
    return typeof value === "string" && /^[a-z0-9._-]{16,96}$/i.test(value) ? value : null;
  }

  function cleanSeed(value) {
    return typeof value === "string" && /^v[a-z0-9]{1,16}$/i.test(value) ? value : null;
  }

  function normalizeState(value) {
    return STATE_IDS.has(value) ? value : "idle";
  }

  function normalizeScene(value) {
    return SCENE_IDS.includes(value) ? value : "jazz";
  }

  function normalizeVisual(value, nextState, nextScene) {
    const source = value && typeof value === "object" ? value : {};
    const fallback = defaultVisual(nextState, nextScene);
    return {
      intensity: clamp01(source.intensity ?? fallback.intensity),
      tension: clamp01(source.tension ?? fallback.tension),
      cps: Math.max(0.25, Math.min(1.2, Number(source.cps ?? fallback.cps) || fallback.cps)),
      phase: PHASE_IDS.has(source.phase) ? source.phase : fallback.phase,
    };
  }

  function normalizeVoices(value, nextState, nextScene) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 4).map((item, index) => {
      const source = item && typeof item === "object" ? item : {};
      const seedValue = cleanSeed(source.seed) || `v${index}`;
      const voiceState = normalizeState(source.state || nextState);
      const voiceScene = normalizeScene(nextScene);
      return {
        role: source.role === "primary" ? "primary" : "secondary",
        state: voiceState,
        seed: seedValue,
        key: cleanKey(source.key) || keyFromSeed(seedValue),
        scaleMode: cleanScaleMode(source.scaleMode, voiceScene) || modeFromSeed(seedValue, voiceScene),
        intensity: clamp01(source.intensity),
        tension: clamp01(source.tension),
        gain: Math.max(0, Math.min(0.7, Number(source.gain) || 0)),
        pan: Math.max(-0.75, Math.min(0.75, Number(source.pan) || 0)),
        phase: PHASE_IDS.has(source.phase) ? source.phase : defaultVisual(voiceState, voiceScene).phase,
      };
    });
  }

  function defaultVisual(nextState = "idle", nextScene = "jazz") {
    const base = {
      idle: [0.08, 0.0, 0.42, "idle"],
      queued: [0.24, 0.1, 0.48, "queued"],
      thinking: [0.42, 0.18, 0.58, "working"],
      tooling: [0.68, 0.28, 0.72, "working"],
      responding: [0.82, 0.08, 0.8, "drop"],
      "awaiting-approval": [0.52, 0.62, 0.54, "approval"],
      compacting: [0.34, 0.22, 0.46, "working"],
      failed: [0.48, 0.92, 0.5, "alert"],
      interrupted: [0.28, 0.72, 0.44, "alert"],
    }[normalizeState(nextState)] || [0.08, 0, 0.42, "idle"];
    const sceneBias = {
      cinematic: 0.02,
      techno: 0.08,
      lofi: -0.02,
      chiptune: 0.1,
      piano: -0.04,
      jazz: 0,
    }[normalizeScene(nextScene)] || 0;
    return {
      intensity: clamp01(base[0]),
      tension: clamp01(base[1]),
      cps: Math.max(0.25, Math.min(1.2, base[2] + sceneBias)),
      phase: base[3],
    };
  }

  function boundedVolume(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_VOLUME;
    return Math.max(0, Math.min(0.3, numeric));
  }

  function clamp01(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, numeric));
  }

  function keyFromSeed(value) {
    return KEY_IDS[seedNumber(value) % KEY_IDS.length] || "c";
  }

  function modeFromSeed(value, nextScene) {
    const modes = SCALE_MODES_BY_SCENE[normalizeScene(nextScene)] || SCALE_MODES_BY_SCENE.jazz;
    return modes[seedNumber(value) % modes.length] || "minor";
  }

  function seedNumber(value) {
    const text = cleanSeed(value) || "v0";
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return hash >>> 0;
  }

  function cleanKey(value) {
    return KEY_IDS.includes(value) ? value : null;
  }

  function cleanScaleMode(value, nextScene) {
    const modes = SCALE_MODES_BY_SCENE[normalizeScene(nextScene)] || SCALE_MODES_BY_SCENE.jazz;
    return modes.includes(value) ? value : null;
  }

  const f = (n, d = 3) => Number(n.toFixed(d)).toString();
  const upper = (k) => String(k || "c").toUpperCase();

  function ramp(value, from, to) {
    if (value <= from) return 0;
    if (value >= to) return 1;
    return (value - from) / (to - from);
  }

  function buildPattern(input) {
    switch (input.scene) {
      case "cinematic":
        return cinematic(input);
      case "techno":
        return techno(input);
      case "lofi":
        return lofi(input);
      case "chiptune":
        return chiptune(input);
      case "piano":
        return piano(input);
      case "jazz":
        return jazz(input);
      default:
        return jazz(input);
    }
  }

  function cinematic(s) {
    const i = s.intensity;
    const t = s.tension;
    const scale = `${upper(s.key)}3:${s.scaleMode}`;
    const bassScale = `${upper(s.key)}1:${s.scaleMode}`;
    const layers = [];
    const padLpf = 280 + i * 3600 - t * 1200;
    layers.push(
      `n("0,2,4").scale("${scale}").s("sawtooth")` +
        `.lpf(sine.range(${f(Math.max(180, padLpf - 400))},${f(Math.max(220, padLpf))}).slow(9))` +
        `.attack(1.4).release(3).gain(${f(0.22 + 0.16 * i)}).room(0.85).slow(4)`,
    );
    if (t > 0.05) {
      layers.push(
        `n("1").scale("${scale}").s("sawtooth").add(note(12))` +
          `.lpf(900).gain(${f(0.18 * t)}).room(0.7).slow(4)`,
      );
    }
    const bassGain = ramp(i, 0.18, 0.5);
    if (bassGain > 0) {
      layers.push(
        `n("0 ~ <0 4> ~").scale("${bassScale}").s("sawtooth")` +
          `.lpf(${f(220 + i * 300)}).attack(0.01).release(0.4).gain(${f(0.32 * bassGain)})`,
      );
    }
    const kickGain = ramp(i, 0.25, 0.6);
    if (kickGain > 0) {
      layers.push(
        `note("c1").s("sine").struct("x ~ ~ ~ x ~ ~ ~")` +
          `.attack(0.001).decay(0.16).sustain(0).gain(${f(0.7 * kickGain)})`,
      );
    }
    const hatGain = ramp(i, 0.4, 0.75);
    if (hatGain > 0) {
      layers.push(
        `s("white").struct("~ x ~ x ~ x ~ x")` +
          `.decay(0.03).sustain(0).hpf(8500).gain(${f(0.18 * hatGain)})`,
      );
    }
    if (s.phase === "drop" || i > 0.8) {
      const lead = ramp(i, 0.78, 0.95);
      layers.push(
        `n("0 2 4 7 4 2").scale("${scale}").s("triangle").fast(2)` +
          `.lpf(${f(2000 + i * 4000)}).gain(${f(0.22 * lead)}).delay(0.35).delaytime(0.18).room(0.4)`,
      );
    }
    return wrap(s, layers);
  }

  function techno(s) {
    const i = s.intensity;
    const t = s.tension;
    const scale = `${upper(s.key)}1:${s.scaleMode}`;
    const layers = [];
    layers.push(
      `note("c1").s("sine").struct("x x x x")` +
        `.attack(0.001).decay(0.18).sustain(0).gain(${f(0.6 + 0.2 * i)})`,
    );
    const bassGain = ramp(i, 0.2, 0.55);
    if (bassGain > 0) {
      layers.push(
        `n("0 0 <3 5> 0").scale("${scale}").s("sawtooth")` +
          `.lpf(sine.range(300,${f(600 + i * 2500)}).slow(4)).gain(${f(0.3 * bassGain)})`,
      );
    }
    const hatGain = ramp(i, 0.3, 0.6);
    if (hatGain > 0) {
      layers.push(
        `s("white").struct("~ x ~ x ~ x ~ x".fast(2))` +
          `.decay(0.025).sustain(0).hpf(9000).gain(${f(0.16 * hatGain)})`,
      );
    }
    const clapGain = ramp(i, 0.45, 0.7);
    if (clapGain > 0) {
      layers.push(
        `s("white").struct("~ ~ ~ ~ x ~ ~ ~")` +
          `.decay(0.12).sustain(0).bpf(2000).gain(${f(0.3 * clapGain)})`,
      );
    }
    if (t > 0.1) {
      layers.push(`s("white").decay(0.6).sustain(0).hpf(${f(2000 + t * 6000)}).gain(${f(0.1 * t)}).slow(8)`);
    }
    return wrap(s, layers);
  }

  function lofi(s) {
    const i = s.intensity;
    const scale = `${upper(s.key)}3:${s.scaleMode}`;
    const bassScale = `${upper(s.key)}2:${s.scaleMode}`;
    const layers = [];
    layers.push(
      `n("<[0,2,4] [1,3,5]>").scale("${scale}").s("triangle")` +
        `.lpf(1600).attack(0.05).release(0.8).gain(${f(0.2 + 0.1 * i)}).room(0.5).slow(2)`,
    );
    layers.push(`n("0 ~ 4 ~").scale("${bassScale}").s("sine").gain(${f(0.25 + 0.1 * i)}).release(0.3)`);
    const kickGain = ramp(i, 0.2, 0.5);
    if (kickGain > 0) {
      layers.push(
        `note("c1").s("sine").struct("x ~ ~ x ~ ~ x ~")` +
          `.decay(0.18).sustain(0).gain(${f(0.55 * kickGain)})`,
      );
      layers.push(
        `s("white").struct("~ ~ x ~ ~ ~ x ~").decay(0.1).sustain(0).bpf(1800).gain(${f(0.18 * kickGain)})`,
      );
    }
    const hatGain = ramp(i, 0.35, 0.65);
    if (hatGain > 0) {
      layers.push(`s("white").struct("x x x x".fast(2)).decay(0.02).sustain(0).hpf(8000).gain(${f(0.1 * hatGain)})`);
    }
    return wrap(s, layers);
  }

  function chiptune(s) {
    const i = s.intensity;
    const t = s.tension;
    const scale = `${upper(s.key)}4:${s.scaleMode}`;
    const leadScale = `${upper(s.key)}5:${s.scaleMode}`;
    const bassScale = `${upper(s.key)}2:${s.scaleMode}`;
    const lowScale = `${upper(s.key)}1:${s.scaleMode}`;
    const layers = [];
    const arpSpeed = 2 + Math.round(i * 2);
    const arp = `<[0 2 4 7]!${arpSpeed} [6 8 10 13]!${arpSpeed} [2 4 6 9]!${arpSpeed} [5 7 9 12]!${arpSpeed}>`;
    layers.push(
      `n("${arp}").scale("${scale}").s("square")` +
        `.gain(${f(0.13 + 0.06 * i)}).release(0.06)` +
        `.delay(0.2).delaytime(0.125).delayfeedback(0.28)` +
        `.pan(sine.range(0.36,0.64).fast(2))`,
    );
    layers.push(
      `n("${arp}").scale("${scale}").s("square").add(note(-0.08))` +
        `.gain(${f(0.05 + 0.03 * i)}).release(0.06).pan(0.72)`,
    );
    layers.push(
      `n("<0 6 2 5>").scale("${bassScale}").s("triangle").struct("x ~ x ~ x ~ x ~")` +
        `.attack(0.004).release(0.1).gain(${f(0.24 + 0.07 * i)})`,
    );
    layers.push(
      `n("<0 6 2 5>").scale("${lowScale}").s("sine")` +
        `.attack(0.01).release(0.3).gain(${f(0.2 + 0.05 * i)})`,
    );
    const counterGain = ramp(i, 0.35, 0.7);
    if (counterGain > 0) {
      layers.push(
        `n("<0 6 2 5>").scale("${bassScale}").s("triangle").add(note(12)).struct("~ x ~ x ~ x ~ x")` +
          `.release(0.07).gain(${f(0.16 * counterGain)})`,
      );
    }
    const kickGain = ramp(i, 0.15, 0.5);
    if (kickGain > 0) {
      layers.push(
        `note("c1").s("triangle").struct("x ~ ~ ~ x ~ x ~")` +
          `.attack(0.001).decay(0.11).sustain(0).gain(${f(0.6 * kickGain)})`,
      );
    }
    const snareGain = ramp(i, 0.3, 0.6);
    if (snareGain > 0) {
      layers.push(`s("white").struct("~ x ~ x").decay(0.09).sustain(0).bpf(2000).gain(${f(0.26 * snareGain)})`);
    }
    const hatGain = ramp(i, 0.4, 0.72);
    if (hatGain > 0) {
      layers.push(`s("white").struct("x x x x".fast(2)).decay(0.02).sustain(0).hpf(8000).gain(${f(0.12 * hatGain)})`);
    }
    if (s.phase === "drop" || i > 0.8) {
      const leadGain = ramp(i, 0.78, 0.96);
      const lead = "<[7 7 6 4] [8 8 10 7] [6 9 11 9] [7 9 6 5]>";
      const leadLpf = f(2600 + i * 4000);
      layers.push(
        `n("${lead}").scale("${leadScale}").s("square")` +
          `.attack(0.004).decay(0.12).sustain(0.7).release(0.12)` +
          `.lpf(${leadLpf}).gain(${f(0.2 * leadGain)})` +
          `.delay(0.3).delaytime(0.1875).delayfeedback(0.32).room(0.3).pan(0.42)`,
      );
      layers.push(
        `n("${lead}").scale("${leadScale}").s("square").add(note(0.09))` +
          `.attack(0.004).decay(0.12).sustain(0.7).release(0.12)` +
          `.lpf(${leadLpf}).gain(${f(0.16 * leadGain)}).pan(0.58)`,
      );
    }
    if (t > 0.1) {
      layers.push(
        `n("<4 6>").scale("${scale}").s("square").add(note(0.12))` +
          `.attack(0.2).release(1.2).lpf(${f(1200 + t * 800)})` +
          `.gain(${f(0.1 * t)}).slow(2)`,
      );
    }
    return wrap(s, layers);
  }

  function piano(s) {
    const i = s.intensity;
    const t = s.tension;
    const scale = `${upper(s.key)}4:${s.scaleMode}`;
    const midScale = `${upper(s.key)}3:${s.scaleMode}`;
    const bassScale = `${upper(s.key)}2:${s.scaleMode}`;
    const lowScale = `${upper(s.key)}1:${s.scaleMode}`;
    const layers = [];
    layers.push(
      `n("<0 ~ <5 3> ~>").scale("${bassScale}").s("triangle")` +
        `.attack(0.006).decay(0.9).sustain(0.3).release(1.4)` +
        `.lpf(${f(800 + i * 700)}).gain(${f(0.26 + 0.07 * i)}).room(0.7).slow(2)`,
    );
    const arpSpeed = 2 + Math.round(i * 2);
    layers.push(
      `n("0 2 4 7 4 2").scale("${scale}").s("triangle").fast(${arpSpeed})` +
        `.attack(0.004).decay(0.5).sustain(0).release(0.5)` +
        `.lpf(${f(2200 + i * 3200)}).gain(${f(0.15 + 0.07 * i)})` +
        `.room(0.8).delay(0.18).delaytime(0.33).delayfeedback(0.25)`,
    );
    const shimmer = ramp(i, 0.35, 0.72);
    if (shimmer > 0) {
      layers.push(
        `n("0 2 4 7 4 2").scale("${scale}").s("sine").add(note(12)).fast(${arpSpeed})` +
          `.attack(0.004).decay(0.4).sustain(0).hpf(1200)` +
          `.gain(${f(0.07 * shimmer)}).room(0.85)`,
      );
    }
    const padGain = ramp(i, 0.2, 0.62);
    if (padGain > 0) {
      layers.push(
        `n("0,2,4").scale("${midScale}").s("sawtooth")` +
          `.lpf(sine.range(500,${f(1200 + i * 1400)}).slow(8))` +
          `.attack(1.6).release(3).gain(${f(0.12 * padGain)}).room(0.9).slow(4)`,
      );
    }
    if (t > 0.08) {
      layers.push(
        `n("1").scale("${midScale}").s("triangle").add(note(7))` +
          `.attack(0.6).release(2.4).lpf(1400).gain(${f(0.12 * t)}).room(0.7).slow(4)`,
      );
    }
    if (s.phase === "drop" || i > 0.82) {
      const peak = ramp(i, 0.8, 0.97);
      layers.push(
        `n("7 4 2 4 0 ~").scale("${scale}").s("triangle")` +
          `.attack(0.004).decay(0.7).sustain(0).gain(${f(0.18 * peak)})` +
          `.lpf(4200).room(0.85).delay(0.25).delaytime(0.4).delayfeedback(0.3)`,
      );
      layers.push(
        `n("0").scale("${lowScale}").s("triangle")` +
          `.attack(0.01).decay(1.6).sustain(0).gain(${f(0.3 * peak)}).room(0.75).slow(2)`,
      );
    }
    return wrap(s, layers);
  }

  function jazz(s) {
    const i = s.intensity;
    const t = s.tension;
    const scale = `${upper(s.key)}3:${s.scaleMode}`;
    const leadScale = `${upper(s.key)}4:${s.scaleMode}`;
    const bassScale = `${upper(s.key)}2:${s.scaleMode}`;
    const layers = [];
    layers.push(
      `n("<[0 2 3 4] [5 4 2 0] [0 1 2 4] [4 3 2 1]>").scale("${bassScale}").s("triangle")` +
        `.attack(0.012).decay(0.34).sustain(0.16).release(0.18)` +
        `.lpf(${f(520 + i * 520)}).gain(${f(0.32 + 0.06 * i)}).room(0.28)`,
    );
    layers.push(
      `s("white").struct("x [x@2 x] x [x@2 x]")` +
        `.decay(0.07).sustain(0).hpf(7200).gain(${f(0.09 + 0.05 * i)}).room(0.35)`,
    );
    const compGain = ramp(i, 0.1, 0.5);
    layers.push(
      `n("~ <[0,2,4,6] [1,3,5,7]> ~ ~ <[0,2,4,6] [-1,1,3,5]> ~ ~ ~").scale("${scale}").s("sine")` +
        `.attack(0.006).decay(0.55).sustain(0).release(0.35)` +
        `.lpf(${f(1600 + i * 1800)}).gain(${f(0.11 + 0.1 * compGain)})` +
        `.room(0.5).delay(0.12).delaytime(0.36).delayfeedback(0.18)`,
    );
    const brushGain = ramp(i, 0.2, 0.55);
    if (brushGain > 0) {
      layers.push(`s("white").struct("~ x ~ x").decay(0.13).sustain(0).bpf(2400).gain(${f(0.16 * brushGain)}).room(0.4)`);
    }
    const kickGain = ramp(i, 0.4, 0.72);
    if (kickGain > 0) {
      layers.push(`note("c1").s("sine").struct("x ~ x ~ x ~ x ~").attack(0.002).decay(0.14).sustain(0).gain(${f(0.28 * kickGain)})`);
    }
    if (t > 0.08) {
      layers.push(
        `n("<[0,3,6] [1,4,6]>").scale("${scale}").s("sawtooth")` +
          `.attack(0.5).release(2).lpf(${f(900 + t * 600)})` +
          `.gain(${f(0.1 * t)}).room(0.7).slow(2)`,
      );
    }
    if (s.phase === "drop" || i > 0.8) {
      const solo = ramp(i, 0.78, 0.96);
      layers.push(
        `n("4 ~ <6 5> 7 6 4 <2 1> ~").scale("${leadScale}").s("triangle")` +
          `.attack(0.02).decay(0.4).sustain(0.2).release(0.3)` +
          `.lpf(${f(2600 + i * 2600)}).gain(${f(0.2 * solo)})` +
          `.room(0.45).delay(0.2).delaytime(0.3).delayfeedback(0.25)`,
      );
      layers.push(
        `n("0").scale("${bassScale}").s("sine").struct("x ~ ~ ~")` +
          `.attack(0.01).decay(0.5).sustain(0.2).gain(${f(0.26 * solo)}).room(0.3)`,
      );
    }
    return wrap(s, layers);
  }

  function wrap(s, layers) {
    const body = layers.length ? layers.join(",\n  ") : `s("silence")`;
    const masterLpf = s.tension > 0.2 ? `.lpf(${f(20000 - s.tension * 14000)})` : "";
    const normalizedVolume = Math.max(0, Math.min(0.3, Number(s.volume) || DEFAULT_VOLUME));
    const masterGain = Math.abs(normalizedVolume - DEFAULT_VOLUME) > 0.001 ? `.gain(${f(normalizedVolume / DEFAULT_VOLUME)})` : "";
    return `setcps(${f(s.cps, 3)})\nstack(\n  ${body}\n)${masterLpf}${masterGain}.analyze(1)`;
  }
})();
