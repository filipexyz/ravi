# Ravi Bot

Claude-powered bot integrated with notif.sh using the Claude Agent SDK.

## Architecture

```
Client → notif.sh (ravi.*.prompt) → RaviBot → Claude Agent SDK
                                       ↓
Client ← notif.sh (ravi.*.response) ←──┘
```

## Topics

```
ravi.<session>.prompt     # Send prompt
ravi.<session>.response   # Receive response
```

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
# Terminal 1: Start bot
npm run start

# Terminal 2: Start TUI chat
npm run tui
```

## Storage

Chat history saved to `~/.ravi/chat.db` (SQLite).

```sql
SELECT * FROM messages WHERE session_id = 'main';
```

## Environment

- `ANTHROPIC_API_KEY`: API key (optional if system authenticated)
- `RAVI_MODEL`: Model (default: sonnet)
- `RAVI_LOG_LEVEL`: debug | info | warn | error

## Development

```bash
npm install
npm run start    # bot server
npm run tui      # chat interface
npm run dev      # bot watch mode
npm run typecheck
```
