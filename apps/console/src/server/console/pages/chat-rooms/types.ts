// Shapes shared by the Console, the Pages Worker room and the chat panel.
// The source of truth is `/mnt/project-files/pages-chat/build/CONTRACT.md`
// and `.ravi/specs/console/pages/chat-rooms/SPEC.md`.

import { z } from "zod";

export const RAVI_UI_VERSION = "ravi.ui/v1";

export type ChatRoomKind = "shared" | "private";
export type ChatViewerRole = "member" | "guest";

export type ChatAuthor =
  | { type: "user"; userId: string; displayName: string; role: ChatViewerRole }
  | { type: "agent"; displayName: string }
  | { type: "system"; displayName: "Ravi" };

const shortText = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().uuid();

/**
 * A UI block the agent may put in a reply. Never HTML or script: a widget of
 * the org Library by ref (rendered with its compiled code and the org theme),
 * a Bases view or chart by id (each viewer loads the rows with their own
 * rights), buttons, or a plain card.
 */
export const raviUiBlockSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("widget"),
      widget: z.string().trim().regex(/^[a-z0-9][a-z0-9._/-]{0,119}$/),
      data: z.record(z.string().max(64), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal("view"),
      viewId: uuid,
      layout: z.enum(["list", "table", "board", "gallery"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("chart"), chartId: uuid }).strict(),
  z
    .object({
      kind: z.literal("actions"),
      actions: z
        .array(z.object({ id: shortText(64), label: shortText(60) }).strict())
        .min(1)
        .max(6),
    })
    .strict(),
  z
    .object({
      kind: z.literal("card"),
      title: shortText(120),
      body: z.string().trim().max(2_000).optional(),
      fields: z
        .array(z.object({ label: shortText(60), value: z.string().trim().max(300) }).strict())
        .max(12)
        .optional(),
      link: z
        .object({ label: shortText(60), href: z.string().trim().url().max(2_000).refine((href) => /^https:\/\//.test(href)) })
        .strict()
        .optional(),
    })
    .strict(),
]);

export type RaviUiBlock = z.infer<typeof raviUiBlockSchema>;

export type ChatPart =
  | { type: "ui"; block: RaviUiBlock }
  | { type: "tool"; toolCallId: string; title: string; status: "running" | "done" | "failed" }
  | {
      type: "confirmation";
      confirmationId: string;
      forUserId: string;
      summary: string;
      changes?: Array<{ label: string; value: string }>;
      status: "pending" | "confirmed" | "cancelled" | "expired";
    }
  | { type: "action"; actionId: string; label: string; replyToMessageId: string }
  | { type: "notice"; text: string };

export type ChatMessageStatus = "complete" | "streaming" | "failed";
export type ChatMessageSource = "text" | "voice" | "comment";

export type ChatMessage = {
  id: string;
  roomId: string;
  seq: number;
  author: ChatAuthor;
  text: string;
  parts: ChatPart[];
  status: ChatMessageStatus;
  source: ChatMessageSource;
  clientMessageId: string | null;
  anchor: unknown | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type ChatTurnStatus = "queued" | "running" | "waiting_confirmation" | "complete" | "failed";

export type RoomEvent =
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.updated"; message: ChatMessage }
  | { type: "message.delta"; messageId: string; text: string }
  | { type: "message.deleted"; messageId: string; seq: number }
  | { type: "turn.status"; turnId: string; messageId: string; status: ChatTurnStatus; label?: string };

export const CHAT_MESSAGE_TEXT_MAX = 4_000;
export const CHAT_HISTORY_PAGE = 50;

// ---------------------------------------------------------------------------
// Request bodies (Worker -> Console)

const host = z.string().trim().min(1).max(253);
const pagesSession = z.string().min(1).max(512).nullable();

export const openRoomBodySchema = z
  .object({
    host,
    path: z.string().trim().min(1).max(1024),
    pagesSession,
    kind: z.enum(["shared", "private"]).default("shared"),
  })
  .strict();

export const sendMessageBodySchema = z
  .object({
    host,
    pagesSession,
    roomId: uuid,
    clientMessageId: z.string().trim().min(1).max(100),
    text: z.string().max(CHAT_MESSAGE_TEXT_MAX).default(""),
    anchor: z.record(z.string().max(64), z.unknown()).nullable().optional(),
    action: z
      .object({ actionId: shortText(64), label: shortText(60), replyToMessageId: uuid })
      .strict()
      .nullable()
      .optional(),
    // Comments come into the room from the comment endpoint, never from the panel.
    source: z.enum(["text", "voice"]).default("text"),
    // Voice mode posts both sides of the call: what the person said and what the agent said back (K9).
    speaker: z.enum(["user", "assistant"]).default("user"),
  })
  .strict()
  .refine((body) => body.text.trim().length > 0 || Boolean(body.action), { message: "Write something.", path: ["text"] })
  .refine((body) => body.speaker === "user" || (body.source === "voice" && !body.action), {
    message: "Only a voice transcript may speak for the assistant.",
    path: ["speaker"],
  });

export const listMessagesBodySchema = z
  .object({
    host,
    pagesSession,
    roomId: uuid,
    afterSeq: z.number().int().min(0).optional(),
    beforeSeq: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const deleteMessageBodySchema = z.object({ host, pagesSession, roomId: uuid, messageId: uuid }).strict();

export const readRoomBodySchema = z.object({ host, pagesSession, roomId: uuid, seq: z.number().int().min(0) }).strict();

export const confirmBodySchema = z
  .object({ host, pagesSession, roomId: uuid, confirmationId: uuid, decision: z.enum(["confirm", "cancel"]) })
  .strict();

export const widgetsBodySchema = z
  .object({
    host,
    pagesSession,
    refs: z.array(z.string().trim().min(1).max(120)).max(20),
  })
  .strict();
