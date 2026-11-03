import type { Database } from "bun:sqlite";
import { PageChatSession, type PageChatDurableObjectNamespace, type PageChatEnv, type SocketLike } from "../src/page-chat";

/** Preserves voice API/state/alarms; does not claim in-memory sideband survives restart. */
export class BunVoiceSessions implements PageChatDurableObjectNamespace {
  private readonly objects = new Map<string, PageChatSession>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: Database, private readonly env: PageChatEnv) {
    db.exec("CREATE TABLE IF NOT EXISTS pages_voice_state (id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,key))");
    db.exec("CREATE TABLE IF NOT EXISTS pages_voice_alarms (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }
  idFromName(name: string) { return { toString: () => name }; }
  get(id: { toString(): string }) {
    const name = id.toString();
    return { fetch: (input: Request | string, init?: RequestInit) => this.serial(name, () => this.object(name).fetch(new Request(input, init))) };
  }
  private serial<T>(name: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.locks.get(name) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.locks.set(name, pending);
    void pending.finally(() => { if (this.locks.get(name) === pending) this.locks.delete(name); }).catch(() => undefined);
    return pending;
  }
  private object(name: string) {
    const found = this.objects.get(name);
    if (found) return found;
    const db = this.db;
    const object = new PageChatSession({
      blockConcurrencyWhile: (action) => action(),
      storage: {
        async get<T>(key: string) {
          const row = db.query("SELECT value FROM pages_voice_state WHERE id=? AND key=?").get(name, key) as { value: string } | null;
          return row ? JSON.parse(row.value) as T : undefined;
        },
        async put<T>(key: string, value: T) { db.query("INSERT INTO pages_voice_state(id,key,value) VALUES(?,?,?) ON CONFLICT(id,key) DO UPDATE SET value=excluded.value").run(name, key, JSON.stringify(value)); },
        async delete(key) { return db.query("DELETE FROM pages_voice_state WHERE id=? AND key=?").run(name, key).changes > 0; },
        async setAlarm(at) { db.query("INSERT INTO pages_voice_alarms(id,at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at").run(name, Number(at)); },
        async deleteAlarm() { db.query("DELETE FROM pages_voice_alarms WHERE id=?").run(name); },
      },
    }, { ...this.env, connectVoiceSideband });
    this.objects.set(name, object);
    return object;
  }
  start() {
    this.timer = setInterval(() => {
      const rows = this.db.query("SELECT id FROM pages_voice_alarms WHERE at<=? LIMIT 25").all(Date.now()) as { id: string }[];
      for (const { id } of rows) {
        if (this.locks.has(id)) continue;
        void this.serial(id, async () => {
          // Keep a retry alarm until the object durably advances/deletes it.
          this.db.query("UPDATE pages_voice_alarms SET at=? WHERE id=?").run(Date.now() + 30_000, id);
          await this.object(id).alarm();
        }).catch(() => console.error("pages_voice_alarm_failed"));
      }
    }, 1000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}

async function connectVoiceSideband(endpoint: string, headers: Record<string, string>): Promise<SocketLike> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("voice_sideband_requires_tls");
  url.protocol = "wss:";
  // lib.dom narrows the global constructor; Bun's native constructor additionally
  // accepts request headers (never offered to the browser).
  const NativeWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new NativeWebSocket(url.toString(), { headers });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("voice_sideband_timeout")); }, 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("voice_sideband_failed")); }, { once: true });
  });
  return {
    accept() { /* Native WebSocket is already open. */ },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) => socket.addEventListener(type, listener as EventListener),
  };
}
