# Ravi Bot

Claude-powered bot integrated with notif.sh using the Claude Agent SDK.

## Architecture

```
┌─────────────┐
│    TUI      │──────────────────────────────────────┐
└─────────────┘                                      │
                                                     ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│  WhatsApp   │────▶│   Bridge    │────▶│      notif.sh       │
└─────────────┘     └─────────────┘     │  ravi.*.prompt      │
                                        └──────────┬──────────┘
                                                   │
                                                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│  WhatsApp   │◀────│   Bridge    │◀────│      RaviBot        │
└─────────────┘     └─────────────┘     │  Claude Agent SDK   │
                          ▲             └─────────────────────┘
                          │
                    notif.sh (ravi.*.response)
```

## Topics

```
ravi.<session>.prompt     # Send prompt
ravi.<session>.response   # Receive response
ravi.<session>.debug      # Debug events
```

**Session IDs:**
- `main` - Default TUI session
- `wa-<phone>` - WhatsApp sessions (e.g., `wa-5511999999999`)

## Messages

**Prompt:**
```json
{"prompt": "Hello!"}
```

**Response:**
```json
{"response": "Hi!", "usage": {"input_tokens": 3, "output_tokens": 5}}
```

**Error:**
```json
{"error": "Something went wrong"}
```

## Usage

```bash
# Terminal 1: Start bot server
npm run start

# Terminal 2: Start TUI chat
npm run tui

# Terminal 3: Start WhatsApp bridge (optional)
npm run wa
```

## WhatsApp Integration

The WhatsApp bridge connects WhatsApp to RaviBot via notif.sh using Baileys.

**First run:**
1. Run `npm run wa`
2. Scan the QR code with WhatsApp (Settings > Linked Devices)
3. Auth credentials saved to `~/.ravi/whatsapp-auth/`

**Features:**
- Real-time message handling
- Typing indicators
- Auto-reconnection with exponential backoff
- Session persistence

**Session mapping:**
- WhatsApp JID `5511999999999@s.whatsapp.net` → Session `wa-5511999999999`
- Group JID `123456789@g.us` → Session `wa-123456789`

## Storage

Chat history saved to `~/.ravi/chat.db` (SQLite).

```sql
-- TUI messages
SELECT * FROM messages WHERE session_id = 'main';

-- WhatsApp messages
SELECT * FROM messages WHERE session_id LIKE 'wa-%';
```

## Environment

- `ANTHROPIC_API_KEY`: API key (optional if system authenticated)
- `RAVI_MODEL`: Model (default: sonnet)
- `RAVI_LOG_LEVEL`: debug | info | warn | error

## Development

```bash
npm install
npm run start      # bot server
npm run tui        # TUI chat interface
npm run wa         # WhatsApp bridge
npm run dev        # bot watch mode
npm run wa:dev     # WhatsApp watch mode
npm run typecheck
```
