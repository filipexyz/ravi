import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessage,
  Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { Notif } from "notif.sh";
import { logger } from "./utils/logger.js";
import { isAllowed, savePendingContact, normalizePhone, isGroup } from "./contacts.js";
import type { ResponseMessage } from "./bot.js";

const log = logger.child("whatsapp");

export interface WhatsAppBridgeOptions {
  authDir?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

/**
 * WhatsApp Bridge - Connects WhatsApp to RaviBot via notif.sh
 *
 * Flow:
 * WhatsApp Message → Bridge → notif.sh (ravi.wa-{jid}.prompt) → RaviBot
 *                                                                  ↓
 * WhatsApp Reply ← Bridge ← notif.sh (ravi.wa-{jid}.response) ←────┘
 */
export class WhatsAppBridge {
  private notif: Notif;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private authDir: string;
  private running = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private responseSubscriptions = new Map<string, AbortController>();

  constructor(options: WhatsAppBridgeOptions = {}) {
    this.authDir = options.authDir || "~/.ravi/whatsapp-auth".replace("~", process.env.HOME || "");
    this.notif = new Notif();
    if (options.logLevel) {
      logger.setLevel(options.logLevel);
    }
  }

  /**
   * Start the WhatsApp bridge.
   */
  async start(): Promise<void> {
    log.info("Starting WhatsApp bridge...");
    this.running = true;
    await this.connect();
  }

  /**
   * Stop the WhatsApp bridge.
   */
  async stop(): Promise<void> {
    log.info("Stopping WhatsApp bridge...");
    this.running = false;

    // Cancel all response subscriptions
    for (const [, controller] of this.responseSubscriptions) {
      controller.abort();
    }
    this.responseSubscriptions.clear();

    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.notif.close();
    log.info("WhatsApp bridge stopped");
  }

  /**
   * Connect to WhatsApp.
   */
  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    log.info("Using WhatsApp version", { version });

    const baileysLogger = pino({ level: "silent" });

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers.ubuntu("Chrome"),
      logger: baileysLogger,
      markOnlineOnConnect: false,
    });

    this.sock = sock;

    // Handle connection updates
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      log.debug("Connection update", { connection, hasQr: !!qr });

      if (qr) {
        log.info("Scan QR code with WhatsApp (Settings > Linked Devices):");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "connecting") {
        log.info("Connecting to WhatsApp...");
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        log.info("Connected to WhatsApp!", { user: sock.user?.id });
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        log.warn("Disconnected from WhatsApp", {
          statusCode,
          reason: DisconnectReason[statusCode] || "unknown",
        });

        if (shouldReconnect && this.running) {
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
            setTimeout(() => this.connect(), delay);
          } else {
            log.error("Max reconnection attempts reached");
          }
        } else if (statusCode === DisconnectReason.loggedOut) {
          log.error("Logged out - delete auth folder and restart to re-authenticate");
        }
      }
    });

    // Save credentials on update
    sock.ev.on("creds.update", saveCreds);

    // Handle incoming messages
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        // Skip own messages
        if (message.key.fromMe) continue;

        // Skip status broadcasts
        if (message.key.remoteJid === "status@broadcast") continue;

        await this.handleIncomingMessage(message);
      }
    });
  }

  /**
   * Handle an incoming WhatsApp message.
   */
  private async handleIncomingMessage(message: WAMessage): Promise<void> {
    const jid = message.key.remoteJid!;

    // Debug: log raw JID
    log.info("Raw JID received", { jid });

    // Skip groups for now
    if (isGroup(jid)) {
      log.debug("Ignoring group message", { jid });
      return;
    }

    const text = this.extractMessageText(message);
    const senderName = message.pushName || "Unknown";
    const phone = normalizePhone(jid);

    log.info("Normalized phone", { jid, phone });

    if (!text) {
      log.debug("Ignoring non-text message", { jid });
      return;
    }

    // Check if contact is allowed
    if (!isAllowed(phone)) {
      // Save as pending for later approval
      savePendingContact(phone, senderName);
      log.info("Saved pending contact", { phone, senderName });
      return;
    }

    log.info("Received message", { phone, senderName, textLen: text.length });

    // Create session ID from JID (sanitize for topic name)
    const sessionId = this.jidToSessionId(jid);

    // Show typing indicator
    await this.sock?.sendPresenceUpdate("composing", jid);

    // Subscribe to response for this session
    this.subscribeToResponse(sessionId, jid);

    // Emit prompt to notif.sh
    try {
      await this.notif.emit(`ravi.${sessionId}.prompt`, { prompt: text });
      log.debug("Emitted prompt", { sessionId });
    } catch (err) {
      log.error("Failed to emit prompt", err);
      await this.sendWhatsAppMessage(jid, "Sorry, something went wrong. Please try again.");
      await this.sock?.sendPresenceUpdate("paused", jid);
    }
  }

  /**
   * Subscribe to response topic for a session.
   */
  private subscribeToResponse(sessionId: string, jid: string): void {
    // Skip if already subscribed
    if (this.responseSubscriptions.has(sessionId)) return;

    const controller = new AbortController();
    this.responseSubscriptions.set(sessionId, controller);

    const topic = `ravi.${sessionId}.response`;

    (async () => {
      try {
        for await (const event of this.notif.subscribe(topic)) {
          if (controller.signal.aborted) break;

          const response = event.data as unknown as ResponseMessage;

          // Stop typing indicator
          await this.sock?.sendPresenceUpdate("paused", jid);

          if (response.error) {
            await this.sendWhatsAppMessage(jid, `Error: ${response.error}`);
          } else if (response.response) {
            await this.sendWhatsAppMessage(jid, response.response);
          }

          log.debug("Sent response to WhatsApp", {
            sessionId,
            jid,
            hasError: !!response.error,
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          log.error("Response subscription error", err);
        }
      }
    })();
  }

  /**
   * Send a message via WhatsApp.
   */
  private async sendWhatsAppMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) {
      log.error("Cannot send message - not connected");
      return;
    }

    try {
      await this.sock.sendMessage(jid, { text });
    } catch (err) {
      log.error("Failed to send WhatsApp message", err);
    }
  }

  /**
   * Extract text content from a WhatsApp message.
   */
  private extractMessageText(message: WAMessage): string | undefined {
    const m = message.message;
    return (
      m?.conversation ||
      m?.extendedTextMessage?.text ||
      m?.imageMessage?.caption ||
      m?.videoMessage?.caption ||
      undefined
    );
  }

  /**
   * Convert a JID to a valid session ID.
   * Example: "5511999999999@s.whatsapp.net" -> "wa-5511999999999"
   */
  private jidToSessionId(jid: string): string {
    // Remove @s.whatsapp.net or @g.us suffix
    const phone = jid.split("@")[0];
    // Prefix with wa- to identify WhatsApp sessions
    return `wa-${phone}`;
  }
}
