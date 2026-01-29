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
# Start bot
npm run start

# Send prompt
notif emit 'ravi.main.prompt' '{"prompt":"Oi!"}' \
  --reply-to 'ravi.main.response' --timeout 60s --raw
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
npm run dev      # watch mode
npm run start    # production
npm run typecheck
```
