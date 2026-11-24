/**
 * `handsfree` engine: a LiveKit room. The app joins with a token the daemon
 * mints; the token also dispatches the `ravi-voice` worker
 * (packages/ravi-voice-worker, Node 24) into the room. The worker hears and
 * speaks; the session behind the door does the work.
 */
import { SignJWT } from "jose";
import type { VoiceEngineDescriptor } from "./types.js";
import { envHas } from "./types.js";

export const HANDSFREE_AGENT_NAME = "ravi-voice";
/** LiveKit Ship plan overage, STT and TTS at the "value" stack, per conversation minute (estimate). */
export const HANDSFREE_USD_PER_MINUTE = 0.03;
const DEFAULT_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export const handsfreeEngine: VoiceEngineDescriptor = {
  id: "handsfree",
  label: "Mãos livres (sala LiveKit + worker de voz)",
  connectionKind: "room",
  capabilities: {
    bargeIn: true,
    streamingAudio: true,
    exactSpeech: true,
    serverAudio: false,
    needs: ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
  },
  costPerMinuteUsd: HANDSFREE_USD_PER_MINUTE,
  check(env = process.env) {
    const missing = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter((name) => !envHas(env, name));
    return {
      engine: "handsfree",
      ready: missing.length === 0,
      missing,
      notes: [
        "The ravi-voice worker (packages/ravi-voice-worker) must be running on Node 24 with its own device key.",
        "LiveKit's free Build plan stops calls after 5,000 participant-minutes a month.",
      ],
    };
  },
};

export interface RoomTokenInput {
  room: string;
  identity: string;
  name?: string;
  /** Dispatch the voice worker when the room is created. */
  dispatchAgent?: { agentName: string; metadata: string };
  ttlSeconds?: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export interface RoomToken {
  roomUrl: string;
  token: string;
  expiresAt: number;
}

export async function mintLiveKitRoomToken(input: RoomTokenInput): Promise<RoomToken> {
  const env = input.env ?? process.env;
  const roomUrl = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!roomUrl || !apiKey || !apiSecret) {
    throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required for hands-free calls");
  }
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  const claims: Record<string, unknown> = {
    name: input.name ?? input.identity,
    video: {
      room: input.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };
  if (input.dispatchAgent) {
    claims.roomConfig = {
      name: input.room,
      emptyTimeout: 60,
      agents: [{ agentName: input.dispatchAgent.agentName, metadata: input.dispatchAgent.metadata }],
    };
  }
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(apiKey)
    .setSubject(input.identity)
    .setJti(input.identity)
    .setNotBefore(nowSeconds)
    .setExpirationTime(nowSeconds + ttl)
    .sign(new TextEncoder().encode(apiSecret));
  return { roomUrl, token, expiresAt: (nowSeconds + ttl) * 1000 };
}
