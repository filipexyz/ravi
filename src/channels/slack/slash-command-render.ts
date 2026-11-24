/**
 * `/ravi` answers, in Slack's words and mrkdwn.
 *
 * The engine (src/chat-commands/engine.ts) says what a command came to as
 * facts; the channel decides how to word and format them. This is the Slack
 * side: English text, mrkdwn escaping, an ephemeral message.
 *
 * Spec: channels/slack/commands.
 */

import type { ChatCommandResult, ChatThreadRow } from "../../chat-commands/engine.js";
import { type SlackCommandMessage, slackCommandHelpMessage, slackCommandMessage } from "./slash-commands.js";

const TITLE_MAX_LENGTH = 70;

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function oneLine(value: string | null | undefined, max = TITLE_MAX_LENGTH): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return escapeMrkdwn(clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** `now`, `12 min`, `3 h`, `2 d`. */
export function formatSlackCommandAge(ms: number): string {
  if (ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function threadStateLabel(row: ChatThreadRow): string {
  const parts: string[] = [];
  if (row.busy) parts.push("working");
  else if (row.health === "attention") parts.push("needs attention");
  else if (row.health === "interrupted") parts.push("interrupted");
  else parts.push("idle");
  if (row.openDecisionCount > 0) {
    parts.push(`${row.openDecisionCount} open ${plural(row.openDecisionCount, "question", "questions")}`);
  }
  if (row.returnPending) parts.push("return pending");
  if (row.sessionGone) parts.push("session gone");
  return parts.join(", ");
}

/** Why a thread did not close, in words, with the way out when there is one. */
function refusalText(name: string, code: string, message: string): string {
  const label = `\`${escapeMrkdwn(name)}\``;
  if (code === "THREAD_TRIGGERS_PENDING") {
    const ids =
      /active triggers: ([^.]+)\./
        .exec(message)?.[1]
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? [];
    const list = ids.length > 0 ? ` (${ids.map((id) => `\`${escapeMrkdwn(id)}\``).join(", ")})` : "";
    return [
      `Did not close ${label}: it still receives active triggers${list}.`,
      "Point each one at the channel session with `ravi triggers set <id> replySession <channel-session>` and run it again.",
    ].join("\n");
  }
  if (code === "THREAD_DECISIONS_PENDING") {
    return `Did not close ${label}: there is an open question or an answer not yet delivered. Answer it and confirm delivery before closing.`;
  }
  if (code === "THREAD_PARENT_RETURN_PENDING") {
    return `Did not close ${label}: the previous return to the channel session is still pending. Try again in a moment.`;
  }
  return `I could not close ${label} (\`${code}\`).`;
}

function cloneRefusalText(code: string, message: string, command: string): string {
  if (code === "CLONE_NAME_INVALID") {
    return `That name does not work for a channel: use lowercase letters, digits, \`-\` or \`_\` (up to 80), like \`${command} clone pesquisa-voz\`.`;
  }
  if (code === "CLONE_NAME_TAKEN") return "A session with that name already exists. Pick another name.";
  if (code === "CLONE_CHANNEL_UNSUPPORTED") return "Cloning is not available for this chat yet.";
  if (code === "CLONE_ORIGIN_UNBOUND") return "This session is not bound to a chat, so there is nothing to clone into.";
  return `I could not clone this session (\`${code}\`): ${oneLine(message)}`;
}

/** The Slack message for one result. `command` is the command as typed, with its slash: `/ravi`. */
export function renderSlackCommandResult(result: ChatCommandResult, command: string): SlackCommandMessage {
  switch (result.kind) {
    case "static":
      return slackCommandHelpMessage(command, {
        ...(result.parse.kind === "unknown" ? { unknown: result.parse.word } : {}),
        ...(result.parse.kind === "usage" ? { usage: result.parse.command } : {}),
      });

    case "stale":
      return slackCommandMessage("That command arrived late and was *not run*. Run it again.");

    case "unknown_actor":
      return slackCommandMessage(
        "I don't recognize you in this workspace, so nothing ran. Ask whoever administers Ravi to link your Slack user to a contact.",
      );

    case "no_route":
      return slackCommandMessage("No agent answers in this chat.");

    case "route_conflict":
      return slackCommandMessage(
        "The route for this chat forces a session that belongs to another agent, so nothing ran. An operator has to fix the route.",
      );

    case "session_missing":
      return slackCommandMessage(
        `Agent \`${result.agentId}\` answers here, but there is no session yet: nobody has spoken in this chat.`,
      );

    case "not_authorized": {
      const label = escapeMrkdwn(result.sessionName);
      return slackCommandMessage(
        result.need === "modify"
          ? `You are not allowed to change session \`${label}\`.`
          : `You do not have access to session \`${label}\`.`,
      );
    }

    case "access_metadata_missing":
      return slackCommandMessage("I could not check your permission for this command, so nothing ran.");

    case "not_authorized_command":
      return slackCommandMessage(
        `You are not allowed to ${
          result.operation === "interrupt"
            ? "stop turns"
            : result.operation === "clone"
              ? "clone sessions"
              : "close threads"
        }${result.capability ? ` (missing \`${result.capability}\`)` : ""}.`,
      );

    case "threads_unsupported":
      return slackCommandMessage("Threads are not available here.");

    case "status": {
      const lines = [
        `*Who answers here*: agent \`${result.agentId}\` · session \`${escapeMrkdwn(result.sessionName)}\``,
        `*Model*: ${escapeMrkdwn(result.runtime)}`,
        `*Now*: ${result.workingForMs === null ? "idle" : `working for ${formatSlackCommandAge(result.workingForMs)}`}`,
      ];
      if (result.openThreads !== null) lines.push(`*Open threads*: ${result.openThreads}`);
      return slackCommandMessage(lines.join("\n"));
    }

    case "thread_status": {
      const { thread } = result;
      const title = thread.title ? ` ${oneLine(thread.title)}` : "";
      const lines = [`*Thread* \`${escapeMrkdwn(thread.name)}\`${title}`];
      // Closing a thread does not interrupt a turn, so a closed thread can still be working: say both.
      lines.push(`*State*: ${thread.closed ? "closed, " : ""}${threadStateLabel(thread)}`);
      const age = formatSlackCommandAge(thread.ageMs);
      lines.push(`*Last activity*: ${age === "now" ? age : `${age} ago`}`);
      if (thread.pendingAnswerCount > 0) {
        lines.push(`*Answers not delivered yet*: ${thread.pendingAnswerCount}`);
      }
      return slackCommandMessage(lines.join("\n"));
    }

    case "threads_none":
      return slackCommandMessage(`No open threads in \`${escapeMrkdwn(result.sessionName)}\`.`);

    case "threads": {
      const label = escapeMrkdwn(result.sessionName);
      const lines = result.rows.map((row) => {
        const title = row.title ? ` ${oneLine(row.title)}` : "";
        return `• \`${escapeMrkdwn(row.name)}\`${title} (${formatSlackCommandAge(row.ageMs)}; ${threadStateLabel(row)})`;
      });
      if (result.more > 0) lines.push(`… and ${result.more} more`);
      return slackCommandMessage([`*Open threads in \`${label}\`* (${result.total})`, ...lines].join("\n"));
    }

    case "thread_not_found":
      return slackCommandMessage(
        `I could not find thread \`${escapeMrkdwn(result.ref.slice(0, 80))}\` in \`${escapeMrkdwn(result.sessionName)}\`. See the names with \`${command} threads\`.`,
      );

    case "thread_close_refused":
      return slackCommandMessage(refusalText(result.name, result.code, result.message));

    case "thread_closed":
      return slackCommandMessage(
        result.changed
          ? `Closed thread \`${escapeMrkdwn(result.name)}\`.`
          : `Thread \`${escapeMrkdwn(result.name)}\` was already closed.`,
      );

    case "idle_none": {
      const label = escapeMrkdwn(result.sessionName);
      return slackCommandMessage(
        result.active > 0
          ? `No thread in \`${label}\` has been idle for more than ${result.hours} h: ${result.active} old ${plural(result.active, "thread has", "threads have")} recent activity or work in progress.`
          : `No thread in \`${label}\` has been idle for more than ${result.hours} h.`,
      );
    }

    case "idle_closed": {
      const label = escapeMrkdwn(result.sessionName);
      const lines = [
        `Closed ${result.closed} ${plural(result.closed, "thread", "threads")} idle for more than ${result.hours} h in \`${label}\`.`,
      ];
      for (const { code, count } of result.refused) {
        lines.push(
          `• ${count} refused: \`${code}\`${code === "THREAD_TRIGGERS_PENDING" ? " (still receives active triggers)" : ""}`,
        );
      }
      if (result.active > 0) lines.push(`• ${result.active} skipped: recent activity or work in progress.`);
      if (result.left > 0) {
        lines.push(
          result.closed > 0
            ? `${result.left} more for the next round: run the command again.`
            : `${result.left} more not tried: nothing closed, so running it again will not get further until the refusals above are resolved.`,
        );
      }
      return slackCommandMessage(lines.join("\n"));
    }

    case "stop_timeout":
      return slackCommandMessage(
        "The runtime did not answer in time, so I do not know whether the turn stopped. Check with `status`.",
      );

    case "stop_unreachable":
      return slackCommandMessage("I could not reach the runtime right now. Nothing was interrupted.");

    case "stopped":
      return slackCommandMessage(
        `Interrupted the turn running in \`${escapeMrkdwn(result.sessionName)}\`. The queue goes on.`,
      );

    case "nothing_running":
      return slackCommandMessage(`Nothing running in \`${escapeMrkdwn(result.sessionName)}\`.`);

    case "session_not_active":
      return slackCommandMessage(
        `Session \`${escapeMrkdwn(result.sessionName)}\` has no active runtime on this host: nothing to interrupt.`,
      );

    case "stop_failed":
      return slackCommandMessage(`I could not interrupt (\`${result.code}\`).`);

    case "cloned": {
      const lines = [
        `Cloned \`${escapeMrkdwn(result.sessionName)}\` into <#${result.chatId}> (session \`${escapeMrkdwn(result.cloneName)}\`), with the last ${result.messages} ${plural(result.messages, "message", "messages")} as context${result.redacted ? " (secrets masked)" : ""}.`,
        "The new session goes on by itself: nothing there comes back here.",
      ];
      if (result.inviteFailed) lines.push("I could not invite you: join the channel yourself.");
      return slackCommandMessage(lines.join("\n"));
    }

    case "clone_refused":
      return slackCommandMessage(cloneRefusalText(result.code, result.message, command));

    case "failed":
      return slackCommandMessage("I could not run that right now. Try again in a moment.");
  }
}
