# Cross-Send ACL System (Future)

## Overview

Control which sessions each agent can send messages to via `cross_send`.

## Current State

- Any agent can `cross_send` to any session
- Validation: target must be full session key, session must exist
- No permission checks

## Proposed ACL Model

### Agent Configuration

```typescript
interface AgentCrossConfig {
  mode: "bypass" | "allowlist" | "denylist";
  allowlist?: string[];  // Session key patterns
  denylist?: string[];   // Session key patterns
}
```

### Pattern Matching

Patterns support wildcards:
- `agent:main:*` — All sessions of agent main
- `agent:*:whatsapp:*` — All WhatsApp sessions
- `*:group:*` — All group sessions
- `agent:main:main` — Exact match

### Examples

**Restrictive (allowlist):**
```json
{
  "mode": "allowlist",
  "allowlist": [
    "agent:main:main",
    "agent:e2-filipe:*"
  ]
}
```
Agent can only send to main's primary session and any e2-filipe session.

**Permissive (denylist):**
```json
{
  "mode": "denylist",
  "denylist": [
    "agent:admin:*",
    "*:group:120363407390920496"
  ]
}
```
Agent can send anywhere except admin sessions and a specific group.

**No restrictions:**
```json
{
  "mode": "bypass"
}
```

## Implementation Plan

### Phase 1: Schema & Storage
- Add `cross_config` column to agents table (JSON)
- Add `AgentCrossConfigSchema` with Zod validation
- CLI: `agents cross <id> [mode|allow|deny|clear] [pattern]`

### Phase 2: Enforcement
- In `cross_send`, check caller's agent context
- Match target against agent's cross config
- Return error with helpful message if denied

### Phase 3: Audit
- Log all cross_send attempts with source agent, target, allowed/denied
- Optional: emit events for monitoring

## CLI Commands

```bash
# Show current config
ravi agents cross main

# Set mode
ravi agents cross main mode allowlist

# Add to allowlist
ravi agents cross main allow "agent:e2-filipe:*"

# Add to denylist
ravi agents cross main deny "agent:admin:*"

# Remove pattern
ravi agents cross main remove "agent:admin:*"

# Reset to bypass
ravi agents cross main clear
```

## Error Messages

```
[ERROR] Permission denied: agent "e2-filipe" cannot send to "agent:admin:main"

Agent cross_send config: allowlist mode
Allowed patterns:
  - agent:main:main
  - agent:e2-filipe:*

Target "agent:admin:main" does not match any allowed pattern.
```

## Security Considerations

- Default should be `bypass` for backwards compatibility
- Sensitive agents (admin, etc) should use `allowlist` mode
- Pattern matching must be strict to prevent bypass via wildcards

## Guardrails (Current Implementation)

### Target Validation

1. **Must be full session key** - Short names like "main" are rejected
   ```
   [ERROR] Invalid target: "main"
   Target must be a full session key (e.g., agent:main:main)

   Did you mean:
     agent:main:main → whatsapp:lid:178035101794451
   ```

2. **Session must exist** - Non-existent sessions are rejected with suggestions
   ```
   [ERROR] Session not found: "agent:foo:bar"

   Available sessions:
     agent:main:main → whatsapp:lid:178035101794451
     agent:e2-filipe:whatsapp:default:group:120363407390920496 → whatsapp:group:...
   ```

3. **Type validation** - Only valid types accepted
   ```
   [ERROR] Invalid type: "notify"
   Valid types: send, contextualize, execute, ask, answer
   ```

### Routing Warnings

When a message is sent to a session without channel routing:
```
✓ [send] sent to agent:main:cli (no routing — response won't reach a channel)
```

This warns the sender that the response won't be delivered to any messaging channel.

### Future Guardrails (with ACL)

1. **Permission check** - Validate sender has permission to target
2. **Rate limiting** - Prevent spam/loops between agents
3. **Audit logging** - Track all cross_send attempts
4. **Loop detection** - Prevent A→B→A→B... message loops
