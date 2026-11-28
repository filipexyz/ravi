/**
 * Hands-free voice worker for Ravi.
 *
 * `ravi voice calls start <session> --mode handsfree` mints a LiveKit room token
 * whose room config dispatches this worker (agent name `ravi-voice`) with job
 * metadata `{ callId }`. The worker never thinks: it turns speech into text,
 * sends each final transcript to the call with its worker key
 * (`voice.calls.send`), and speaks every `agent.transcript` the call emits.
 *
 * Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, RAVI_BASE_URL,
 * RAVI_VOICE_WORKER_KEY (from `ravi voice devices pair --worker --execute`),
 * OPENAI_API_KEY (STT) and ELEVEN_API_KEY (TTS).
 */
import { fileURLToPath } from "node:url";
import { type JobContext, ServerOptions, cli, defineAgent, voice } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { RaviClient, RaviStreamClient, createHttpTransport } from "@ravi-os/sdk";

export const AGENT_NAME = "ravi-voice";

function raviClients() {
  const baseUrl = process.env.RAVI_BASE_URL;
  const contextKey = process.env.RAVI_VOICE_WORKER_KEY;
  if (!baseUrl || !contextKey) throw new Error("RAVI_BASE_URL and RAVI_VOICE_WORKER_KEY are required");
  return {
    client: new RaviClient(createHttpTransport({ baseUrl, contextKey })),
    stream: new RaviStreamClient({ baseUrl, contextKey }),
  };
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const meta = JSON.parse(ctx.job.metadata || "{}") as {
      callId?: string;
      language?: string;
      voice?: string | null;
      ttsModel?: string | null;
      sttModel?: string | null;
    };
    if (!meta.callId) throw new Error("job metadata has no callId");
    const callId = meta.callId;
    const { client, stream } = raviClients();

    await ctx.connect();
    const session = new voice.AgentSession({
      vad: await silero.VAD.load(),
      // The profile's language and voice come with the dispatch; plugin defaults otherwise.
      stt: new openai.STT({
        model: meta.sttModel || "gpt-4o-transcribe",
        ...(meta.language ? { language: meta.language.split("-")[0] } : {}),
      }),
      tts: new elevenlabs.TTS({
        model: meta.ttsModel || "eleven_multilingual_v2",
        ...(meta.voice ? { voiceId: meta.voice } : {}),
      }),
      // No LLM: the Ravi session is the brain.
    });
    await session.start({
      agent: new voice.Agent({ instructions: "Relay only. Ravi answers." }),
      room: ctx.room,
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (!event.isFinal || !event.transcript.trim()) return;
      client.voice.calls.send(callId, [event.transcript]).catch((error) => {
        console.error("[ravi-voice] send failed", error);
      });
    });

    const abort = new AbortController();
    ctx.addShutdownCallback(async () => abort.abort());
    let after = 0;
    while (!abort.signal.aborted) {
      try {
        for await (const message of stream.voiceCall(callId, { after, signal: abort.signal })) {
          if (message.event === "end") return ctx.shutdown("call ended");
          const event = message.data;
          if (event.type !== "call.snapshot") after = Math.max(after, event.seq);
          if (event.type === "agent.transcript" && typeof event.data.text === "string") {
            session.say(event.data.text);
          } else if (event.type === "agent.state" && event.data.reason === "silenced") {
            session.interrupt();
          } else if (event.type === "call.ended") {
            return ctx.shutdown("call ended");
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        console.error("[ravi-voice] stream dropped, resuming", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
