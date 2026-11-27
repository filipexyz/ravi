// Deterministic observer conditions: facts about a finished source turn that the daemon checks
// without a model, so an observer is woken only when something worth seeing happened.
//
// A condition is evaluated over every observation event of one source turn, at end of turn. It
// never reads message text: it reads event types and runtime-set payload fields (commentary,
// silent, reason), so observed content cannot trigger or suppress it.

export const OBSERVATION_CONDITIONS = [
  "turn.no_final_reply",
  "chat.narration",
  "turn.failed",
  "turn.interrupt",
  "tool.idle",
] as const;

export type ObservationCondition = (typeof OBSERVATION_CONDITIONS)[number];

/** What `ravi sessions observe` watches when no `--when` is given. */
export const DEFAULT_ALERT_CONDITIONS: readonly ObservationCondition[] = [
  "turn.no_final_reply",
  "chat.narration",
  "turn.failed",
  "tool.idle",
];

/** Agent replies in one turn from which the turn counts as narration. */
export const NARRATION_THRESHOLD = 2;

export interface ObservationConditionEvent {
  type: string;
  turnId?: string;
  preview?: string;
  payload?: Record<string, unknown>;
}

export interface ObservationConditionHit {
  condition: ObservationCondition;
  turnId?: string;
  detail: string;
}

const CONDITION_SET = new Set<string>(OBSERVATION_CONDITIONS);

export function isObservationCondition(value: string): value is ObservationCondition {
  return CONDITION_SET.has(value);
}

/** Parse a `when` list (binding metadata or CLI flag); unknown names throw. */
export function parseObservationConditions(values: readonly string[]): ObservationCondition[] {
  const parsed: ObservationCondition[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (!isObservationCondition(value)) {
      throw new Error(`Unknown observer condition "${value}". Use one of: ${OBSERVATION_CONDITIONS.join(", ")}.`);
    }
    if (!parsed.includes(value)) parsed.push(value);
  }
  return parsed;
}

function text(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneLine(value: string, max = 160): string {
  const flat = value.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function lastIndex<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index]!)) return index;
  }
  return -1;
}

function isReply(event: ObservationConditionEvent): boolean {
  return event.type === "message.assistant" && event.payload?.commentary !== true;
}

/** A reply a chat saw: a session whose output never reaches a chat (a work thread) does not narrate. */
function isChatReply(event: ObservationConditionEvent): boolean {
  return isReply(event) && event.payload?.chatEmitted !== false;
}

function isToolEvent(event: ObservationConditionEvent): boolean {
  return event.type === "tool.start" || event.type === "tool.end" || event.type === "tool.inactive";
}

/**
 * Conditions met by each finished turn in `events`. A turn without a terminal event (`turn.*`) is
 * still running and yields nothing. Order follows the turns, then the condition list.
 */
export function evaluateObservationConditions(events: readonly ObservationConditionEvent[]): ObservationConditionHit[] {
  const turns = new Map<string, ObservationConditionEvent[]>();
  for (const event of events) {
    const key = event.turnId ?? "";
    const list = turns.get(key);
    if (list) list.push(event);
    else turns.set(key, [event]);
  }

  const hits: ObservationConditionHit[] = [];
  for (const [key, turnEvents] of turns) {
    const terminalIndex = lastIndex(turnEvents, (event) => event.type.startsWith("turn."));
    if (terminalIndex < 0) continue;
    const terminal = turnEvents[terminalIndex]!;
    const turnId = key || undefined;
    // Runtime reason codes only: a provider error message can quote observed content, and condition
    // lines sit outside the data boundary.
    const reason = text(terminal.payload, "reason") ?? text(terminal.payload, "abortReason");
    const hit = (condition: ObservationCondition, detail: string) =>
      hits.push({ condition, ...(turnId ? { turnId } : {}), detail });

    const lastUser = lastIndex(turnEvents, (event) => event.type === "message.user");
    const afterUser = turnEvents.slice(lastUser + 1, terminalIndex);
    const lastReply = lastIndex(afterUser, isReply);
    const lastTool = lastIndex(afterUser, isToolEvent);
    const silent = terminal.payload?.silent === true;
    if (!silent && (lastReply < 0 || lastTool > lastReply)) {
      hit(
        "turn.no_final_reply",
        lastReply < 0
          ? "the turn ended with no agent message"
          : "the agent kept working after its last message and ended without a final one",
      );
    }

    const replies = turnEvents.filter(isChatReply).length;
    if (replies >= NARRATION_THRESHOLD) {
      hit("chat.narration", `${replies} agent messages in one turn`);
    }

    if (terminal.type === "turn.failed") hit("turn.failed", reason ? oneLine(reason) : "failed");
    if (terminal.type === "turn.interrupt") hit("turn.interrupt", reason ? oneLine(reason) : "interrupted");

    const idle = turnEvents.filter((event) => event.type === "tool.inactive");
    if (idle.length > 0) {
      const names = [
        ...new Set(idle.map((event) => oneLine(text(event.payload, "toolName") ?? event.preview ?? "tool", 60))),
      ];
      hit("tool.idle", `no activity from ${names.join(", ")}`);
    }
  }
  return hits;
}

/** One line per hit, for the observer prompt. */
export function renderObservationConditions(hits: readonly ObservationConditionHit[]): string {
  return hits
    .map((hit) => `⚠ ${hit.condition}${hit.turnId ? ` (turn ${oneLine(hit.turnId, 80)})` : ""}: ${hit.detail}`)
    .join("\n");
}
