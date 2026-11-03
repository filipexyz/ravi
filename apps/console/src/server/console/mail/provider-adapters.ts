export type MailProviderAdapterName = "cloudflare_email" | "aws_ses" | (string & {});

export type MailProviderSupportStatus = "beta" | "ga" | "unsupported";

export type MailProviderRateLimitModel = "provider_account" | "domain" | "mailbox" | "unknown";

export type MailProviderCapabilities = {
  inbound: boolean;
  outbound: boolean;
  attachments: boolean;
  maxMessageBytes: number;
  maxRecipientsPerMessage: number;
  customDomains: boolean;
  catchAll: boolean;
  subaddressing: boolean;
  suppressionEvents: boolean;
  deliveryEvents: boolean;
  rateLimitModel: MailProviderRateLimitModel;
  costDimensions: MailUsageMetricKey[];
  supportStatus: MailProviderSupportStatus;
};

export type MailUsageMetricKey =
  | "mail.messages.inbound"
  | "mail.messages.outbound"
  | "mail.recipients.outbound"
  | "mail.bytes.inbound"
  | "mail.bytes.outbound"
  | "mail.attachments.bytes_stored"
  | "mail.parser.jobs"
  | "mail.delivery.events"
  | "mail.suppression.events";

export type MailProviderCapability = keyof Pick<
  MailProviderCapabilities,
  | "inbound"
  | "outbound"
  | "attachments"
  | "customDomains"
  | "catchAll"
  | "subaddressing"
  | "suppressionEvents"
  | "deliveryEvents"
>;

export type MailCipherPayloadKind =
  | "raw_mime"
  | "parsed_body"
  | "headers"
  | "subject"
  | "address_summary"
  | "attachment";

export type MailCipherRef = {
  scheme: "ravi-mail-cipher-ref";
  ref: string;
  payloadKind: MailCipherPayloadKind;
  keyVersion: string;
  sizeBytes: number;
  sha256?: string | null;
};

export type MailProviderInboundEnvelope = {
  providerAdapter: MailProviderAdapterName;
  providerMessageRefHash: string;
  senderHash: string;
  recipientHashes: string[];
  rawSizeBytes?: number | null;
  receivedAt: string;
};

export type MailInboundAcceptedMessage = {
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  routeId: string;
  messageId: string;
  providerAdapter: MailProviderAdapterName;
  envelope: MailProviderInboundEnvelope;
  rawMimeCipherRef: MailCipherRef;
};

export type MailOutboundAddress = {
  address: string;
  mailboxId?: string | null;
  domainId?: string | null;
};

export type MailOutboundDraft = {
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  from: MailOutboundAddress;
  to: string[];
  cc?: string[];
  bcc?: string[];
  rawMimeCipherRef: MailCipherRef;
  subjectCipherRef?: MailCipherRef | null;
  headersCipherRef?: MailCipherRef | null;
  sizeBytes: number;
  idempotencyKey: string;
};

export type MailOutboundAuthorization =
  | {
      ok: true;
      actorId: string;
      organizationId: string;
      mailboxId: string;
      fromAddress: string;
      grantedAt: string;
    }
  | {
      ok: false;
      reason: "missing_send_permission" | "cross_organization" | "mailbox_inactive" | "from_not_authorized";
    };

export type MailVerifiedSender =
  | {
      verified: true;
      scope: "address";
      address: string;
      domain: string;
      verifiedAt: string;
    }
  | {
      verified: true;
      scope: "domain";
      domain: string;
      verifiedAt: string;
    }
  | {
      verified: false;
      reason: "domain_unverified" | "sender_unverified" | "provider_not_ready";
    };

export type MailAuthorizedOutboundSendRequest = MailOutboundDraft & {
  authorization: Extract<MailOutboundAuthorization, { ok: true }>;
  verifiedSender: Extract<MailVerifiedSender, { verified: true }>;
};

export type MailOutboundSendContext = {
  /**
   * Plaintext required only while handing the already-authorized message to the
   * provider. Adapters must not persist or log these values.
   */
  transientMessage?: {
    subject: string;
    text: string;
  };
};

export type MailOutboundSendResult = {
  providerAdapter: MailProviderAdapterName;
  providerMessageRefHash: string;
  acceptedAt: string;
  deliveryEventRefHash?: string | null;
};

export interface MailProviderAdapter {
  readonly name: MailProviderAdapterName;
  readonly capabilities: MailProviderCapabilities;
  sendOutbound(request: MailAuthorizedOutboundSendRequest, context?: MailOutboundSendContext): Promise<MailOutboundSendResult>;
}

export type MailOutboundRejectionReason =
  | "adapter_outbound_unsupported"
  | "from_not_authorized"
  | "sender_not_verified"
  | "sender_scope_mismatch";

export type MailOutboundPrepareResult =
  | {
      ok: true;
      request: MailAuthorizedOutboundSendRequest;
    }
  | {
      ok: false;
      reason: MailOutboundRejectionReason;
      publicError: "mail_send_denied";
    };

export async function sendOutboundMailWithAdapter({
  adapter,
  authorization,
  context,
  draft,
  verifiedSender,
}: {
  adapter: MailProviderAdapter;
  authorization: MailOutboundAuthorization;
  context?: MailOutboundSendContext;
  draft: MailOutboundDraft;
  verifiedSender: MailVerifiedSender;
}): Promise<MailOutboundPrepareResult | { ok: true; result: MailOutboundSendResult }> {
  const prepared = prepareOutboundMailSend({
    adapter,
    authorization,
    draft,
    verifiedSender,
  });

  if (!prepared.ok) return prepared;

  return {
    ok: true,
    result: await adapter.sendOutbound(prepared.request, context),
  };
}

export function prepareOutboundMailSend({
  adapter,
  authorization,
  draft,
  verifiedSender,
}: {
  adapter: Pick<MailProviderAdapter, "capabilities">;
  authorization: MailOutboundAuthorization;
  draft: MailOutboundDraft;
  verifiedSender: MailVerifiedSender;
}): MailOutboundPrepareResult {
  if (!adapter.capabilities.outbound) {
    return outboundDenied("adapter_outbound_unsupported");
  }

  if (!authorization.ok || normalizeMailAddress(authorization.fromAddress) !== normalizeMailAddress(draft.from.address)) {
    return outboundDenied("from_not_authorized");
  }

  if (!verifiedSender.verified) {
    return outboundDenied("sender_not_verified");
  }

  if (!verifiedSenderAllowsFrom(verifiedSender, draft.from.address)) {
    return outboundDenied("sender_scope_mismatch");
  }

  return {
    ok: true,
    request: {
      ...draft,
      authorization,
      verifiedSender,
    },
  };
}

export function providerSupportsCapability(
  adapter: Pick<MailProviderAdapter, "capabilities">,
  capability: MailProviderCapability,
): boolean {
  return adapter.capabilities[capability];
}

function verifiedSenderAllowsFrom(sender: Extract<MailVerifiedSender, { verified: true }>, fromAddress: string): boolean {
  const normalizedFrom = normalizeMailAddress(fromAddress);
  const fromDomain = normalizedFrom.split("@")[1];

  if (!fromDomain) return false;

  if (sender.scope === "address") {
    return normalizeMailAddress(sender.address) === normalizedFrom;
  }

  return sender.domain.toLowerCase() === fromDomain;
}

function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase();
}

function outboundDenied(reason: MailOutboundRejectionReason) {
  return {
    ok: false,
    reason,
    publicError: "mail_send_denied",
  } as const;
}
