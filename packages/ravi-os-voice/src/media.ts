import type { RaviVoiceCall, VoiceMode, createRaviVoice } from "./call.js";

/**
 * Push-to-talk recorder: `start()` on press, `stop()` on release sends the clip.
 * Uses MediaRecorder (webm/opus in Chromium and Firefox, mp4 in Safari).
 */
export function pushToTalk(call: RaviVoiceCall, options: { mimeType?: string } = {}) {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];

  return {
    async start(): Promise<void> {
      if (recorder) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType =
        options.mimeType ?? ["audio/webm;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.start();
      // `when_idle` replies wait while the person talks. A failed signal never blocks recording.
      call.activity("speaking").catch(() => {});
    },
    async stop() {
      const active = recorder;
      if (!active) return null;
      recorder = null;
      const done = new Promise<void>((resolve) => {
        active.onstop = () => resolve();
      });
      active.stop();
      await done;
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      await call.activity("quiet").catch(() => null);
      const clip = new Blob(chunks, { type: (active.mimeType || "audio/webm").split(";")[0] });
      if (!clip.size) return null;
      return call.push(clip);
    },
  };
}

/**
 * Plays every spoken reply with audio (push and mock calls). Live calls carry
 * audio on WebRTC; hands-free calls in the room.
 */
export function autoplayReplies(call: RaviVoiceCall, element: HTMLAudioElement = new Audio()) {
  let current: string | null = null;
  // Bumped only on silence and cleanup: clips queued before that never play.
  let generation = 0;
  // Replies play in arrival order, one after another; each clip downloads as
  // soon as its transcript arrives.
  let queue: Promise<void> = Promise.resolve();
  const off = call.on("agent.transcript", (event) => {
    const audio = event.data.audio as { item?: string } | undefined;
    if (!audio?.item) return;
    const mine = generation;
    const download = call.audio(audio.item).catch(() => null);
    // A clip that fails never holds the replies behind it.
    queue = queue
      .then(async () => {
        const blob = await download;
        if (!blob || mine !== generation) return;
        if (current) URL.revokeObjectURL(current);
        current = URL.createObjectURL(blob);
        element.src = current;
        await element.play().catch(() => undefined);
        await playbackDone(element);
      })
      .catch(() => undefined);
  });
  const offSilence = call.on("agent.state", (event) => {
    if (event.data.state === "listening" && event.data.reason === "silenced") {
      generation++;
      element.pause();
    }
  });
  return () => {
    generation++;
    off();
    offSilence();
    element.pause();
    if (current) URL.revokeObjectURL(current);
    current = null;
  };
}

/** Resolves when the element stops: the clip ended, was paused, failed, or never started. */
function playbackDone(element: HTMLAudioElement): Promise<void> {
  if (element.paused || element.ended || element.error) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      element.removeEventListener("ended", done);
      element.removeEventListener("pause", done);
      element.removeEventListener("error", done);
      resolve();
    };
    element.addEventListener("ended", done);
    element.addEventListener("pause", done);
    element.addEventListener("error", done);
  });
}

/**
 * Live mode: opens a WebRTC connection to the live model. The model speaks
 * and listens; the session behind it does the work.
 */
export async function connectLive(
  voice: ReturnType<typeof createRaviVoice>,
  session: string,
  options: { profile?: string; element?: HTMLAudioElement; mic?: MediaStream } = {},
) {
  const pc = new RTCPeerConnection();
  const element = options.element ?? new Audio();
  element.autoplay = true;
  pc.ontrack = (event) => {
    element.srcObject = event.streams[0] ?? null;
  };
  const mic = options.mic ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
  for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const call = await voice.start(session, { mode: "live" as VoiceMode, profile: options.profile, offer: offer.sdp });
  if (!call.info.sdpAnswer) {
    pc.close();
    throw new Error("The live engine returned no SDP answer");
  }
  await pc.setRemoteDescription({ type: "answer", sdp: call.info.sdpAnswer });
  return {
    call,
    peer: pc,
    mute(muted: boolean) {
      for (const track of mic.getAudioTracks()) track.enabled = !muted;
    },
    async hangUp() {
      for (const track of mic.getTracks()) track.stop();
      pc.close();
      await call.end();
    },
  };
}

/** Minimal surface of `livekit-client` this kit uses (optional peer dependency). */
interface LiveKitModule {
  Room: new () => {
    connect(url: string, token: string): Promise<void>;
    disconnect(): Promise<void>;
    localParticipant: { setMicrophoneEnabled(enabled: boolean): Promise<unknown> };
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  RoomEvent: { TrackSubscribed: string };
}

/**
 * Hands-free mode: joins the call's LiveKit room, where the `ravi-voice`
 * worker listens and speaks. Needs `livekit-client` installed.
 */
export async function joinRoom(call: RaviVoiceCall, options: { element?: HTMLAudioElement } = {}) {
  let url = call.info.roomUrl;
  let token = call.info.roomToken;
  if (!url || !token) {
    const fresh = await call.connect();
    url = fresh.roomUrl;
    token = fresh.roomToken;
  }
  if (!url || !token) throw new Error("This call has no room");
  const moduleName = "livekit-client";
  const livekit = (await import(/* @vite-ignore */ moduleName)) as LiveKitModule;
  const room = new livekit.Room();
  room.on(livekit.RoomEvent.TrackSubscribed, (track: unknown) => {
    const attachable = track as { kind?: string; attach?: (el?: HTMLMediaElement) => HTMLMediaElement };
    if (attachable.kind === "audio" && attachable.attach) attachable.attach(options.element);
  });
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  return {
    room,
    mute: (muted: boolean) => room.localParticipant.setMicrophoneEnabled(!muted),
    async hangUp() {
      await room.disconnect();
      await call.end();
    },
  };
}
