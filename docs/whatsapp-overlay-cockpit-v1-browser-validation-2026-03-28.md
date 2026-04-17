# WhatsApp Overlay Cockpit v1 Browser Validation

Date: 2026-03-28

Status: `FIX-FIRST`

Scope validated:

- browser-real validation through the live WhatsApp Overlay bridge
- checklist from `docs/whatsapp-overlay-manual-checklist.md`
- focus on cross-chat navigation hardening, row/chat correlation, and `inspect == UI`

Operational note:

- local overlay bridge was restarted during validation
- the main Ravi daemon was not restarted

## Verdict

The cockpit is not ready to pull `approval` into this cut yet.

`approval badge` is explicitly Phase 4 polish in `docs/whatsapp-overlay-cockpit-v1.md`, and that phase only starts after deterministic navigation feels solid. The current browser-real run still breaks deterministic open and can leave the native pane in a degraded search-results state.

## Evidence

Commands used during validation:

```bash
bun run wa:overlay:cli health
bun run wa:overlay:cli current
bun run wa:overlay:cli inspect --json
curl -s http://127.0.0.1:4210/api/whatsapp-overlay/current | jq ...
curl -s -X POST http://127.0.0.1:4210/api/whatsapp-overlay/dom/command ...
```

Live observations captured:

1. Initial stable state:
   - bridge healthy on `127.0.0.1:4210`
   - overlay client connected
   - `inspect --json` resolved visible rows such as `Ravi - Dev`, `achados ia - dev`, `E2`, and `Vida - Health`
2. Case `chat already open` against the focused `namas` session:
   - current chat was still `namas`
   - clicking `Abrir chat` returned a DOM click success
   - notice rendered `abrindo 120363408215043032@g.us...`
   - expected success notice `X já estava aberto` did not appear
3. Case `visible row` with `dev / Ravi - Dev`:
   - cockpit focus changed to `dev`
   - `Abrir chat` correctly repointed to `data-ravi-open-chat="dev"`
   - after the open attempt, the overlay publish stream stopped advancing for several seconds
4. After bridge recovery:
   - current state came back with the native left pane still in `Resultados da pesquisa.`
   - cockpit still contained `dev`
   - visible native rows no longer contained `Ravi - Dev`

## Findings

### HIGH — already-open detection fails for sessions whose cockpit title falls back to `chatId`

The focused `namas` session had no `displayName` or `subject`, only `chatId`. The open flow therefore labeled the target as `120363408215043032@g.us` and compared against `currentTitle/currentChatId` using that value. In the live page, the selected chat surface exposed `namas` and no `chatIdCandidate`, so `isTargetOpenNow()` missed the already-open match and entered the open flow instead of returning success immediately.

Relevant code:

- `getCockpitChatTitle()` in `extensions/whatsapp-overlay/content.js:3623`
- `openCockpitChat()` in `extensions/whatsapp-overlay/content.js:3642`
- `openGenericChatTarget()` in `extensions/whatsapp-overlay/content.js:3664`
- `isTargetOpenNow()` in `extensions/whatsapp-overlay/content.js:3767`

Live evidence:

- current selected chat: `namas`
- focused recent session for `namas`: `displayName=null`, `subject=null`, `chatId=120363408215043032@g.us`
- notice after click: `abrindo 120363408215043032@g.us...`

### HIGH — native search state can leak into the UI and break deterministic navigation

After the navigation attempts, the native grid was still published as `Resultados da pesquisa.`. At that point the cockpit still exposed `dev`, but the visible native rows no longer included `Ravi - Dev`. This breaks the intended invariant that the cockpit navigation is mapped to the native pane with deterministic row selection and confirmation.

Relevant code:

- deterministic open/search fallback in `extensions/whatsapp-overlay/content.js:3664`
- native search mutation and cleanup in `extensions/whatsapp-overlay/content.js:3690`

Live evidence after recovery:

- `cockpitHasDev = true`
- visible rows: `ravi`, `SDE Ravi Admin`, `Ravi - MORE`, `achados ia - dev`, `Builders SP: Claude Code`, `E2`, `namas`, `Vida - Health`, `Embarcados`, `IT NETWORKING 2`
- native grid probe path: `div[role=grid][aria-label=Resultados da pesquisa.]`

### MEDIUM — DOM command / publish loop lost liveness during the `Ravi - Dev` open attempt

The `dev -> Abrir chat` attempt returned no confirmed chat change and the published `postedAt` stopped advancing for several seconds. The bridge had to be restarted locally to continue the run. That points to a liveness issue in the overlay command/publish path and prevented full coverage of checklist cases 2-4 in a single uninterrupted session.

Relevant code surfaces:

- navigation flow in `extensions/whatsapp-overlay/content.js:3664`
- DOM command polling in `extensions/whatsapp-overlay/content.js:4064`

## Checklist Outcome

- Case 1. Chat already open: `FAIL`
- Case 2. Row visible in native list: `FAIL`
- Case 3. Fallback via native search: `BLOCKED BY FIX-FIRST`
- Case 4. Explicit failure: `PARTIAL`

What passed:

- live bridge health
- initial row/session correlation from `inspect`
- cockpit snapshot still exposes recent sessions coherently

What did not pass:

- already-open success acknowledgement
- deterministic visible-row open
- stable cleanup of native search state
- uninterrupted liveness of the browser bridge after the open attempt

## Approval Decision

`approval` should enter later, not now.

Why:

- the design puts `approval badge` in Phase 4, after navigation solidity
- the current run still fails the Phase 3 deterministic-open bar from `docs/whatsapp-overlay-cockpit-v1.md:236`

## Next Cut

Smallest next cut that is worth doing before approval:

1. Fix already-open matching so cockpit rows compare against the actual live chat identity, not only `displayName/subject/chatId` fallback text.
2. Guarantee native search cleanup on every exit path of `openGenericChatTarget()`, including stale/timeout paths.
3. Add a browser-real regression harness for:
   - already-open
   - visible-row open
   - search fallback
   - explicit failure
4. Re-run the manual checklist only after those three land.
