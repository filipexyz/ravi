#!/usr/bin/env python3
"""Auto-recovery for the "runtime session start stayed queued too long" bug.

What the bug looks like: an inbound Slack message triggers a runtime session
start, the start sits in the pending queue and expires; the user gets
"Error: Runtime session start stayed queued too long. Send another message to
retry." and the request is silently lost.

What this script does, every run:
1. finds recent `dispatch.start_timeout` events (session_events, read-only);
2. for each affected Slack chat, reads the Slack history around the failure;
3. finds user messages that exist in Slack but were never ingested into Ravi
   (chat_messages) -- i.e. the messages the pipeline lost;
4. replays those messages through the native channel pipeline;
5. reports recent open threads with a durable published prompt but zero provider
   handoffs, independently of timeout events and without reading parent history.
   Only the orchestrator resumes these; this script cannot atomically arbitrate
   a new provider start and therefore never resets or replays a child prompt.

Safety:
- dry-run by default; --apply performs the replay
- only messages inside the failure window of a chat that actually had a
  start timeout are considered
- per-message cooldown and retry budget, plus a per-run cap
- never replays bot/agent messages, edits, joins or other subtypes
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

OPERATOR_HOME = Path.home()
STATE_DIR = Path(os.environ.get("RAVI_STATE_DIR", str(OPERATOR_HOME / ".ravi")))
RAVI_DB = STATE_DIR / "ravi.db"
STATE = STATE_DIR / "ops/queue-recovery-state.json"
LOG = STATE_DIR / "ops/queue-recovery.log"
RAVI = os.environ.get("RAVI_BIN", "")
CANONICAL_RAVI = str(Path(__file__).resolve().parents[2] / "bin/ravi")


def ravi_bin() -> str:
    """Resolve the CLI, ignoring a RAVI_BIN that does not point at a file."""
    for cand in (RAVI, CANONICAL_RAVI, "/usr/local/bin/ravi"):
        if cand and Path(cand).is_file() and os.access(cand, os.X_OK):
            return cand
    return "ravi"

# A pending start expires after the idle-session TTL (5 min); the message that
# triggered it arrives at most that long before the first timeout.
LOOKBACK_MIN = 8.0
IGNORED_SUBTYPES = {"bot_message", "message_changed", "message_deleted", "channel_join", "channel_leave"}


def log(line: str) -> None:
    row = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {line}"
    print(row)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(row + "\n")


def ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def load_state() -> dict:
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(STATE)


def timeout_events(since_ms: int) -> list[sqlite3.Row]:
    conn = ro(RAVI_DB)
    try:
        return conn.execute(
            """
            select session_name, source_channel, source_account_id, source_chat_id,
                   timestamp, message_id, payload_json
            from session_events
            where event_type = 'dispatch.start_timeout'
              and timestamp > ?
              and source_channel = 'slack'
              and source_chat_id is not null
              and source_chat_id <> ''
            order by timestamp asc
            """,
            (since_ms,),
        ).fetchall()
    finally:
        conn.close()


def ingested(channel: str, instance: str, raw_chat_id: str, provider_message_id: str) -> bool:
    conn = ro(RAVI_DB)
    try:
        row = conn.execute(
            """
            select 1 from chat_messages
            where provider_message_id = ?
              and raw_chat_id = ?
              and channel = ?
              and ifnull(instance_id,'') in (?, '')
              and deleted_at is null
            limit 1
            """,
            (provider_message_id, raw_chat_id, channel, instance),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def slack_history(chat_id: str, connection: str, oldest: str, limit: int) -> list[dict]:
    proc = subprocess.run(
        [
            ravi_bin(), "slack", "channels-history", chat_id,
            "--channel", connection,
            "--oldest", oldest,
            "--limit", str(limit),
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "history failed").strip()[:300])
    return json.loads(proc.stdout or "{}").get("items", [])


def replay(chat_id: str, connection: str, ts: str) -> tuple[bool, str]:
    proc = subprocess.run(
        [
            ravi_bin(), "slack", "messages-replay", chat_id, ts,
            "--channel", connection,
            "--execute", "--json",
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    detail = (proc.stdout or proc.stderr or "").strip()
    return proc.returncode == 0, detail[:400]


def answered_after(session_name: str, after_ts: int) -> bool:
    conn = ro(STATE_DIR / "chat.db")
    try:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(after_ts / 1000))
        row = conn.execute(
            """
            select 1 from messages
            where session_id = ? and role = 'assistant'
              and julianday(created_at) > julianday(?)
            limit 1
            """,
            (session_name, stamp),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def never_started_threads(now_ms: int) -> list[dict]:
    """Use session/trace identity, never a same-chat history fallback.

    A published lifecycle is durable evidence even if its transport prompt has
    expired. Wait ten minutes and exclude any recent dispatch or prior handoff.
    The 24h window bounds this temporary recovery to recent incidents.
    """
    conn = ro(RAVI_DB)
    try:
        return [dict(row) for row in conn.execute(
            """
            select t.child_session_name as session_name, t.parent_session_name,
                   t.initial_prompt, t.prompt_published_at,
                   (select count(*) from session_events e
                    where e.session_key = s.session_key and e.event_type = 'prompt.published') as prompt_count
            from slack_thread_lifecycle t join sessions s on s.session_key = t.child_session_key
            where t.status = 'open' and t.source = 'action'
              and coalesce(s.system_sent, 0) = 0
              and coalesce(s.input_tokens, 0) = 0
              and t.prompt_published_at between ? and ?
              and length(trim(t.initial_prompt)) > 0
              and not exists (select 1 from session_events e where e.session_key = s.session_key
                              and e.event_type in ('adapter.request', 'turn.complete', 'turn.failed', 'turn.interrupted'))
              and not exists (select 1 from session_events e where e.session_key = s.session_key
                              and e.timestamp > ? and e.event_type in
                                ('prompt.published', 'dispatch.cold_start', 'dispatch.queued_busy', 'runtime.start'))
            order by t.prompt_published_at asc
            """, (now_ms - 24 * 3600_000, now_ms - 10 * 60_000, now_ms - 10 * 60_000)
        ).fetchall()]
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually replay (default: dry-run)")
    ap.add_argument("--window-min", type=float, default=90)
    ap.add_argument("--cooldown-hours", type=float, default=4)
    ap.add_argument("--max-attempts", type=int, default=2)
    ap.add_argument("--max-per-run", type=int, default=5)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    now = int(time.time() * 1000)
    since = now - int(args.window_min * 60 * 1000)
    events = timeout_events(since)
    never_started = never_started_threads(now)
    if not events and not never_started:
        if not args.quiet:
            log("nothing-scheduled")
        return 0

    # Group failures per chat, widening the window by the pending-start TTL.
    chats: dict[tuple[str, str, str], dict] = {}
    for ev in events:
        key = (ev["source_channel"], ev["source_account_id"] or "", ev["source_chat_id"])
        entry = chats.setdefault(key, {"first": ev["timestamp"], "last": ev["timestamp"], "sessions": set()})
        entry["first"] = min(entry["first"], ev["timestamp"])
        entry["last"] = max(entry["last"], ev["timestamp"])
        entry["sessions"].add(ev["session_name"])

    state = load_state()
    acted = 0
    recovered: list[str] = []
    notes: list[str] = []
    scanned = 0
    lost_total = 0
    never_started_reports: list[str] = []
    for item in never_started:
        key = f"never-started|{item['session_name']}"
        entry = state.get(key, {})
        if now - int(entry.get("lastTryTs", 0)) < args.cooldown_hours * 3600_000:
            continue
        if acted >= args.max_per_run:
            break
        acted += 1
        if args.apply:
            state[key] = {"lastTryTs": now}
            save_state(state)
        # This script cannot atomically arbitrate with a newly starting provider.
        # Report to the orchestrator; do not reset/replay the initial prompt here.
        never_started_reports.append(f"{item['session_name']} ({max(1, item['prompt_count'])} prompt(s), sem handoff)")

    for (channel, instance, chat_id), info in chats.items():
        connection = instance or "ravi-slack"
        oldest = f"{(info['first'] / 1000 - LOOKBACK_MIN * 60):.6f}"
        try:
            items = slack_history(chat_id, connection, oldest, 100)
        except Exception as exc:  # noqa: BLE001
            notes.append(f"{chat_id}:history-error({exc})")
            continue

        window_start = info["first"] - int(LOOKBACK_MIN * 60 * 1000)
        window_end = now + 30_000
        lost = []
        for item in items:
            ts = item.get("ts")
            if not ts or not item.get("user"):
                continue
            if item.get("bot_id") or item.get("subtype") in IGNORED_SUBTYPES:
                continue
            if not item.get("text"):
                continue
            ts_ms = int(float(ts) * 1000)
            if ts_ms < window_start or ts_ms > window_end:
                continue
            if ingested(channel, instance, chat_id, ts):
                continue
            lost.append(item)

        if not lost:
            continue

        scanned += 1
        lost_total += len(lost)

        for item in lost:
            ts = item["ts"]
            key = f"{chat_id}|{ts}"
            entry = state.get(key, {})
            tries = int(entry.get("tries", 0))
            if tries >= args.max_attempts:
                notes.append(f"{key}:budget-exhausted")
                continue
            last_try = entry.get("lastTryTs")
            if last_try and now - int(last_try) < args.cooldown_hours * 3600 * 1000:
                notes.append(f"{key}:cooldown")
                continue
            if acted >= args.max_per_run:
                notes.append(f"{key}:run-budget")
                continue

            if not args.apply:
                log(f"would-recover chat={chat_id} ts={ts} text={(item.get('text') or '')[:70]!r}")
                acted += 1
                continue

            state[key] = {**entry, "tries": tries + 1, "lastTryTs": now, "text": (item.get("text") or "")[:200]}
            save_state(state)

            ok, detail = replay(chat_id, connection, ts)
            acted += 1
            if ok:
                recovered.append(f"{chat_id}/{ts} ({(item.get('text') or '')[:60]!r})")
                log(f"recovered chat={chat_id} ts={ts} try={tries + 1}")
            else:
                state[key]["lastError"] = detail
                save_state(state)
                log(f"recover-failed chat={chat_id} ts={ts} detail={detail}")

    if notes and not args.quiet:
        log("skipped " + ", ".join(notes[:10]) + (" ..." if len(notes) > 10 else ""))

    # Sessions that keep timing out and never answer: report, do not redeliver
    # (the prompt is already ingested; replaying it could duplicate work).
    stuck: dict[str, dict] = {}
    for ev in events:
        entry = stuck.setdefault(ev["session_name"], {"count": 0, "first": ev["timestamp"]})
        entry["count"] += 1
        entry["first"] = min(entry["first"], ev["timestamp"])
    stuck_reports = []
    for session_name, info in stuck.items():
        if info["count"] < 3:
            continue
        if answered_after(session_name, info["first"]):
            continue
        key = f"stuck|{session_name}"
        entry = state.get(key, {})
        last = entry.get("lastTryTs")
        if last and now - int(last) < 6 * 3600 * 1000:
            continue
        state[key] = {"lastTryTs": now, "count": info["count"]}
        save_state(state)
        stuck_reports.append(f"{session_name} ({info['count']}x)")
    if stuck_reports:
        log("stuck " + ", ".join(stuck_reports))


    if not args.quiet:
        log(
            f"scanned events={len(events)} chats={len(chats)} chats-with-loss={scanned} "
            f"lost={lost_total} acted={acted}"
        )
    summary: list[str] = []
    if recovered:
        summary.append("reinjetei " + "; ".join(recovered))
    if stuck_reports:
        summary.append("ainda travadas sem resposta: " + ", ".join(stuck_reports))
    if never_started_reports:
        summary.append("threads sem primeiro turno, retomar pelo pedido original: " + ", ".join(never_started_reports))
    if summary:
        summary_line = "ACTION: fila — " + " | ".join(summary) + "."
        log(summary_line)
        print(summary_line)  # The cron contract matches lines starting with ACTION:.
    else:
        log(f"IDLE: nada travado (eventos={len(events)}, chats={len(chats)}).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        log(f"fatal {type(exc).__name__}: {exc}")
        sys.exit(1)
