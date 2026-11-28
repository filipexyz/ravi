/**
 * `@ravi-os/voice`: talk to any Ravi session from a browser app.
 *
 *   const voice = createRaviVoice({ baseUrl, contextKey });
 *   const call = await voice.start("main", { mode: "push" });
 *   call.on("agent.transcript", (e) => show(e.data.text));
 *   void call.follow();
 *   const ptt = pushToTalk(call); // ptt.start() on press, ptt.stop() on release
 *   autoplayReplies(call);
 */
export {
  base64ToBlob,
  blobToBase64,
  createRaviVoice,
  type OpenApproval,
  RaviVoiceCall,
  type RaviVoiceConfig,
  type StartCallOptions,
  type VoiceActivity,
  type VoiceEvent,
  type VoiceEventType,
  type VoiceMode,
} from "./call.js";
export { autoplayReplies, connectLive, joinRoom, pushToTalk } from "./media.js";
