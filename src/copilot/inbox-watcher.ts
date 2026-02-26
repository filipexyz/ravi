/**
 * Copilot Inbox Watcher
 *
 * Watches specific CC team inboxes registered via `ravi.copilot.watch` NATS events.
 * When `ravi copilot send` is called, it emits ravi.copilot.watch{team, agentId}
 * which registers a watch. Only registered (team, agentId) pairs are polled.
 *
 * When unread messages appear in inboxes/{agentId}.json, fires them to the
 * agent's main session via NATS and marks them as read.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { getAgent } from "../router/config.js";
import {
  getMainSession,
  getOrCreateSession,
  generateSessionName,
  ensureUniqueName,
  updateSessionName,
  expandHome,
} from "../router/index.js";

const log = logger.child("copilot:inbox-watcher");

const POLL_INTERVAL_MS = 3000;
const TEAMS_DIR = join(homedir(), ".claude", "teams");
const WATCH_TOPIC = "ravi.copilot.watch";

interface InboxMessage {
  from: string;
  text: string;
  read: boolean;
  timestamp: string;
  summary?: string;
  color?: string;
}

interface WatchKey {
  team: string;
  agentId: string;
}

export class InboxWatcher {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Set of "team:agentId" strings
  private watches = new Set<string>();

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("Inbox watcher started", { pollIntervalMs: POLL_INTERVAL_MS });
    this.subscribeToWatchEvents();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watches.clear();
    log.info("Inbox watcher stopped");
  }

  /** Register a (team, agentId) pair to watch. Called from copilot send. */
  register(team: string, agentId: string): void {
    const key = `${team}:${agentId}`;
    if (!this.watches.has(key)) {
      this.watches.add(key);
      log.info("Registered inbox watch", { team, agentId });
    }
  }

  private parseKey(key: string): WatchKey {
    const idx = key.indexOf(":");
    return { team: key.slice(0, idx), agentId: key.slice(idx + 1) };
  }

  private async subscribeToWatchEvents(): Promise<void> {
    try {
      for await (const event of nats.subscribe(WATCH_TOPIC)) {
        if (!this.running) break;
        const { team, agentId } = event.data as { team: string; agentId: string };
        if (team && agentId) {
          this.register(team, agentId);
        }
      }
    } catch (err) {
      if (this.running) {
        log.warn("Watch subscription error, retrying in 5s", { error: err });
        setTimeout(() => this.subscribeToWatchEvents(), 5000);
      }
    }
  }

  private poll(): void {
    if (!this.running || this.watches.size === 0) return;

    for (const key of this.watches) {
      const { team, agentId } = this.parseKey(key);
      const inboxPath = join(TEAMS_DIR, team, "inboxes", `${agentId}.json`);
      if (!existsSync(inboxPath)) continue;

      try {
        this.checkInbox(team, agentId, inboxPath);
      } catch (err) {
        log.warn("Error checking inbox", { team, agentId, error: err });
      }
    }
  }

  private checkInbox(team: string, agentId: string, inboxPath: string): void {
    const raw = readFileSync(inboxPath, "utf-8");
    let messages: InboxMessage[];
    try {
      messages = JSON.parse(raw);
      if (!Array.isArray(messages)) return;
    } catch {
      return;
    }

    const unread = messages.filter((m) => !m.read);
    if (unread.length === 0) return;

    log.info("Found unread inbox messages", { team, agentId, count: unread.length });

    // Mark all as read atomically before firing (prevents double-fire)
    const updated = messages.map((m) => ({ ...m, read: true }));
    const tmpPath = inboxPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, inboxPath);

    for (const msg of unread) {
      this.fireToSession(team, agentId, msg).catch((err) => {
        log.error("Error firing inbox message", { team, agentId, error: err });
      });
    }
  }

  private async fireToSession(team: string, agentId: string, msg: InboxMessage): Promise<void> {
    const sessionName = this.resolveMainSessionName(agentId);

    const prompt = [
      `[Inbox: ${team}]`,
      `From: ${msg.from}`,
      msg.summary ? `Summary: ${msg.summary}` : null,
      ``,
      msg.text,
    ]
      .filter((line) => line !== null)
      .join("\n");

    log.debug("Firing inbox message to session", { team, agentId, sessionName });

    await nats.emit(`ravi.session.${sessionName}.prompt`, {
      prompt,
      _trigger: true,
      _source: "inbox-watcher",
      _team: team,
    });
  }

  private resolveMainSessionName(agentId: string): string {
    const agent = getAgent(agentId);
    const agentCwd = agent ? expandHome(agent.cwd) : `/tmp/ravi-${agentId}`;

    const main = getMainSession(agentId);
    if (main?.name) return main.name;

    const baseName = generateSessionName(agentId, { isMain: true });
    const sessionName = ensureUniqueName(baseName);
    const session = getOrCreateSession(`agent:${agentId}:main`, agentId, agentCwd, {
      name: sessionName,
    });
    if (!session.name) updateSessionName(session.sessionKey, sessionName);
    return sessionName;
  }
}

// Singleton
let watcher: InboxWatcher | null = null;

export function getInboxWatcher(): InboxWatcher {
  if (!watcher) {
    watcher = new InboxWatcher();
  }
  return watcher;
}

export function startInboxWatcher(): void {
  getInboxWatcher().start();
}

export function stopInboxWatcher(): void {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
}
