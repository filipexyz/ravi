/**
 * Capability registry.
 *
 * Every capability the connectors Worker exposes is described here with
 * provider, class, schemas, and adapter dispatch. The proxy executor
 * validates parameters against `input` before calling the adapter and
 * projects the adapter's response through `output` before returning to
 * the caller. Fields not declared in `output` are dropped on the wire.
 *
 * Adding a capability requires registering it here AND implementing the
 * adapter handler. The Worker MUST NOT accept a capability whose entry
 * is missing from this table.
 */

import { z } from "zod";

import {
  requireActionDefinition,
  requireActionProviderDefinition,
} from "../../../../src/shared/integrations/provider-registry";

export type CapabilityClass = "read" | "write" | "destructive";

export interface CapabilityDefinition<
  TIn extends z.ZodTypeAny = z.ZodTypeAny,
  TOut extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly id: string;
  readonly providerId: string;
  readonly class: CapabilityClass;
  readonly requiresStepUp: boolean;
  readonly input: TIn;
  readonly output: TOut;
  readonly requiredProviderScopes: readonly string[];
  readonly timeoutMs: number;
  readonly summary: string;
}

export class CapabilityNotFoundError extends Error {
  constructor(public readonly capability: string) {
    super(`Unknown capability: ${capability}`);
    this.name = "CapabilityNotFoundError";
  }
}

// --------------------------------------------------------------------------
// Gmail
// --------------------------------------------------------------------------

// One Message-ID, `<id@host>` (a bare `id@host` gets its brackets). It is
// written into a header line, so no space, line break or other control
// character: those could start a header of their own (a hidden Bcc).
const gmailMessageId = z
  .string()
  .max(998)
  .regex(/^(?:<[^<>\s\u0000-\u001f\u007f]+>|[^<>\s\u0000-\u001f\u007f]+)$/)
  .transform((value) => (value.startsWith("<") ? value : `<${value}>`));

const gmailSendInput = z.object({
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(2_000_000),
  bodyHtml: z.string().max(2_000_000).optional(),
  inReplyTo: gmailMessageId.optional(),
  references: z.array(gmailMessageId).max(20).optional(),
  threadId: z.string().max(200).optional(),
});

const gmailSendOutput = z.object({
  messageId: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

const gmailMessageListInput = z.object({
  q: z.string().max(500).optional(),
  labelIds: z.array(z.string()).max(20).optional(),
  pageToken: z.string().max(200).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
});

const gmailMessageListOutput = z.object({
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().optional(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        threadId: z.string(),
      }),
    )
    .default([]),
});

const gmailMessageReadInput = z.object({
  id: z.string().min(1).max(200),
  format: z.enum(["full", "metadata", "raw"]).default("full"),
});

const gmailMessageReadOutput = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  sizeEstimate: z.number().int().optional(),
  headers: z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      subject: z.string().optional(),
      date: z.string().optional(),
      replyTo: z.string().optional(),
      messageId: z.string().optional(),
    })
    .default({}),
  body: z
    .object({
      text: z.string().optional(),
      html: z.string().optional(),
    })
    .default({}),
});

// --------------------------------------------------------------------------
// Google Calendar
// --------------------------------------------------------------------------

const gcalEventListInput = z.object({
  calendarId: z.string().min(1).max(200).default("primary"),
  timeMin: z.string().datetime().optional(),
  timeMax: z.string().datetime().optional(),
  q: z.string().max(500).optional(),
  maxResults: z.number().int().min(1).max(250).optional(),
  pageToken: z.string().max(200).optional(),
});

const gcalEventListOutput = z.object({
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        status: z.string().optional(),
        summary: z.string().optional(),
        start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
        end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
        htmlLink: z.string().optional(),
      }),
    )
    .default([]),
});

const gcalFreeBusyQueryInput = z.object({
  timeMin: z.string().datetime({ offset: true }),
  timeMax: z.string().datetime({ offset: true }),
  calendarIds: z.array(z.string().min(1).max(200)).min(1).max(50).default(["primary"]),
  timeZone: z.string().min(1).max(100).optional(),
});

const gcalBusyInterval = z.object({ start: z.string(), end: z.string() });

const gcalFreeBusyQueryOutput = z.object({
  timeMin: z.string().optional(),
  timeMax: z.string().optional(),
  calendars: z
    .array(
      z.object({
        id: z.string(),
        busy: z.array(gcalBusyInterval).default([]),
        errors: z.array(z.object({ reason: z.string().optional() })).optional(),
      }),
    )
    .default([]),
});

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

const gmailMessageSend = implementedAction("gmail.message.send");
const gmailMessageList = implementedAction("gmail.message.list");
const gmailMessageRead = implementedAction("gmail.message.read");
const gcalEventList = implementedAction("gcal.event.list");
const gcalFreeBusyQuery = implementedAction("gcal.freebusy.query");

// Step-up is intentionally disabled across all capabilities for v1: the
// Console session is WorkOS-only (magic link / SSO) and there is no
// password to re-prompt. Step-up re-enables when a real WorkOS factor
// (passkey or TOTP) is wired into the step-up page.
export const capabilityRegistry: Record<string, CapabilityDefinition> = {
  "gmail.message.send": {
    id: "gmail.message.send",
    providerId: gmailMessageSend.provider.connectionProviderId,
    class: gmailMessageSend.action.class,
    requiresStepUp: false,
    input: gmailSendInput,
    output: gmailSendOutput,
    requiredProviderScopes: gmailMessageSend.action.requiredProviderScopes,
    timeoutMs: 10_000,
    summary: gmailMessageSend.action.title,
  },
  "gmail.message.list": {
    id: "gmail.message.list",
    providerId: gmailMessageList.provider.connectionProviderId,
    class: gmailMessageList.action.class,
    requiresStepUp: false,
    input: gmailMessageListInput,
    output: gmailMessageListOutput,
    requiredProviderScopes: gmailMessageList.action.requiredProviderScopes,
    timeoutMs: 10_000,
    summary: gmailMessageList.action.title,
  },
  "gmail.message.read": {
    id: "gmail.message.read",
    providerId: gmailMessageRead.provider.connectionProviderId,
    class: gmailMessageRead.action.class,
    requiresStepUp: false,
    input: gmailMessageReadInput,
    output: gmailMessageReadOutput,
    requiredProviderScopes: gmailMessageRead.action.requiredProviderScopes,
    timeoutMs: 10_000,
    summary: gmailMessageRead.action.title,
  },
  "gcal.event.list": {
    id: "gcal.event.list",
    providerId: gcalEventList.provider.connectionProviderId,
    class: gcalEventList.action.class,
    requiresStepUp: false,
    input: gcalEventListInput,
    output: gcalEventListOutput,
    requiredProviderScopes: gcalEventList.action.requiredProviderScopes,
    timeoutMs: 10_000,
    summary: gcalEventList.action.title,
  },
  "gcal.freebusy.query": {
    id: "gcal.freebusy.query",
    providerId: gcalFreeBusyQuery.provider.connectionProviderId,
    class: gcalFreeBusyQuery.action.class,
    requiresStepUp: false,
    input: gcalFreeBusyQueryInput,
    output: gcalFreeBusyQueryOutput,
    requiredProviderScopes: gcalFreeBusyQuery.action.requiredProviderScopes,
    timeoutMs: 10_000,
    summary: gcalFreeBusyQuery.action.title,
  },
};

/**
 * What a person sees for each capability (Console tool rows, approvals,
 * organization policy). The one place these labels live.
 */
export const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "gmail.message.list": "Search your email",
  "gmail.message.read": "Read your email",
  "gmail.message.send": "Send email",
  "gcal.event.list": "Read your calendar",
  "gcal.freebusy.query": "See when you're free or busy",
};

export function capabilityLabel(id: string): string {
  return CAPABILITY_LABELS[id] ?? capabilityRegistry[id]?.summary ?? id;
}

/** Every capability of a provider, in registry order. */
export function listProviderCapabilities(providerId: string): CapabilityDefinition[] {
  return Object.values(capabilityRegistry).filter((capability) => capability.providerId === providerId);
}

export function getCapability(id: string): CapabilityDefinition {
  const def = capabilityRegistry[id];
  if (!def) throw new CapabilityNotFoundError(id);
  return def;
}

function implementedAction(capability: string) {
  const action = requireActionDefinition(capability);
  const provider = requireActionProviderDefinition(capability);
  if (action.status !== "implemented") {
    throw new CapabilityNotFoundError(capability);
  }
  return { action, provider };
}
