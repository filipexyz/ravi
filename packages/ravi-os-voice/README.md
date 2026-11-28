# @ravi-os/voice

Browser kit for Ravi voice calls. A call sits on an existing Ravi session: the
session does the thinking and the work, the call only carries voice. Built on
`@ravi-os/sdk` (`ravi.voice.calls.*` and the `voice/{call}` stream).

```ts
import { createRaviVoice, pushToTalk, autoplayReplies } from "@ravi-os/voice";

// A device key from `ravi voice devices pair --label phone --contact <id> --session main --execute`
const voice = createRaviVoice({ baseUrl: "https://my-ravi.example", contextKey: DEVICE_KEY });

const call = await voice.start("main", { mode: "push" });
call.on("user.transcript", (e) => showUser(e.data.text));
call.on("agent.transcript", (e) => showAgent(e.data.text));
call.on("turn.approval_requested", (e) => askTap(e.data.approvalId, e.data.text));
void call.follow(); // resumes from the last seq after a drop

const ptt = pushToTalk(call);
button.onpointerdown = () => ptt.start();
button.onpointerup = () => ptt.stop();
autoplayReplies(call);
```

## Modes

| Mode | How audio travels | Kit helper |
|---|---|---|
| `push` | one clip per press; reply clip fetched with `call.audio(item)` | `pushToTalk`, `autoplayReplies` |
| `live` | WebRTC straight to the live model; the session works behind it | `connectLive(voice, session)` |
| `handsfree` | a LiveKit room with the `ravi-voice` worker (needs `livekit-client`) | `joinRoom(call)` |
| `mock` | text only, for tests | `call.say(text)` |

## Configuration

Voice, language, models, transcription and spend limits live in **voice profiles** on the daemon.
`voice.profiles()` and `voice.voices()` list them; an operator, or a key issued with
`mutate:voice:profiles.*`, manages them through `client.voice.profiles.*`. Device keys only read.

A call may change its profile's `voice`, `language`, `ttsModel` or `liveVoice` when the profile lists
the field in `overridable` (closed by default), and only with voices in `allowedVoices` when set:

```ts
const call = await voice.start("main", { profile: "atendimento", voice: "<voice id>", language: "en" });
```

`pushToTalk` tells the call when the person presses and releases (`call.activity("speaking" | "quiet")`),
so a profile with `delivery: when_idle` holds its replies until they stop. Use `call.activity` yourself
with your own voice-activity detection.

Approvals are taps only: `call.approve(id)` sends the version and digest the
call showed, so a request that changed since is refused. Voice can cancel or
deny, never approve.

`call.silence()` stops speech, `call.cancelTurn()` cancels this call's running
turn, `call.end()` ends the call (work already running keeps going).
