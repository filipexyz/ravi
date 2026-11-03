export type MailAddressRejectionReason =
  | "missing"
  | "invalid_type"
  | "invalid_format"
  | "invalid_local_part"
  | "invalid_domain"
  | "reserved_local_part";

export type PublicMailAddressErrorCode = "mail_address_unavailable";

export type MailAddressValidationResult =
  | {
      ok: true;
      address: string;
      localPart: string;
      domain: string;
    }
  | {
      ok: false;
      reason: MailAddressRejectionReason;
      publicError: PublicMailAddressErrorCode;
    };

export type MailLocalPartValidationResult =
  | {
      ok: true;
      localPart: string;
    }
  | {
      ok: false;
      reason: Exclude<MailAddressRejectionReason, "invalid_domain" | "invalid_format">;
      publicError: PublicMailAddressErrorCode;
    };

export type MailSubaddress =
  | {
      hasTag: false;
      baseLocalPart: string;
      tag: null;
    }
  | {
      hasTag: true;
      baseLocalPart: string;
      tag: string;
    };

const PUBLIC_MAIL_ADDRESS_UNAVAILABLE = {
  error: "mail_address_unavailable",
  fieldErrors: {
    address: "This email address is unavailable.",
  },
} as const;

const RESERVED_LOCAL_PARTS = new Set([
  "abuse",
  "admin",
  "mailer-daemon",
  "postmaster",
  "security",
]);

const LOCAL_PART_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SUBADDRESS_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

export function publicMailAddressError() {
  return PUBLIC_MAIL_ADDRESS_UNAVAILABLE;
}

export function isReservedMailLocalPart(localPart: string): boolean {
  return RESERVED_LOCAL_PARTS.has(localPart.toLowerCase());
}

/**
 * Apply the mandatory `-<orgSlug>` suffix to a mailbox local part for
 * Ravi-managed mailboxes. Idempotent: if the local part already ends with
 * `-<orgSlug>`, the input is returned unchanged so suffixes do not stack.
 */
export function applyOrgSlugSuffix(localPart: string, orgSlug: string): string {
  const slug = orgSlug.trim().toLowerCase();
  if (!slug) return localPart;
  const suffix = `-${slug}`;
  return localPart.endsWith(suffix) ? localPart : `${localPart}${suffix}`;
}

export function validateMailboxLocalPart(value: unknown): MailLocalPartValidationResult {
  if (typeof value !== "string") {
    return localPartFailure(value === undefined || value === null ? "missing" : "invalid_type");
  }

  const localPart = value.trim().toLowerCase();
  if (!localPart) return localPartFailure("missing");
  if (localPart.includes("+")) return localPartFailure("invalid_local_part");
  if (!LOCAL_PART_PATTERN.test(localPart)) return localPartFailure("invalid_local_part");
  if (isReservedMailLocalPart(localPart)) return localPartFailure("reserved_local_part");

  return {
    ok: true,
    localPart,
  };
}

export function validateMailboxAddress(value: unknown): MailAddressValidationResult {
  if (typeof value !== "string") {
    return addressFailure(value === undefined || value === null ? "missing" : "invalid_type");
  }

  const address = value.trim().toLowerCase();
  if (!address) return addressFailure("missing");

  const parts = address.split("@");
  if (parts.length !== 2) return addressFailure("invalid_format");

  const [localPart, domain] = parts;
  const local = validateMailboxLocalPart(localPart);
  if (!local.ok) return addressFailure(local.reason);
  if (!domain || !DOMAIN_PATTERN.test(domain)) return addressFailure("invalid_domain");

  return {
    ok: true,
    address: `${local.localPart}@${domain}`,
    localPart: local.localPart,
    domain,
  };
}

export function parseInboundMailAddress(value: unknown): MailAddressValidationResult {
  if (typeof value !== "string") {
    return addressFailure(value === undefined || value === null ? "missing" : "invalid_type");
  }

  const address = value.trim().toLowerCase();
  if (!address) return addressFailure("missing");

  const parts = address.split("@");
  if (parts.length !== 2) return addressFailure("invalid_format");

  const [localPart, domain] = parts;
  if (!localPart || !domain || !DOMAIN_PATTERN.test(domain)) return addressFailure("invalid_domain");

  const subaddress = parseSubaddress(localPart);
  const base = validateMailboxLocalPart(subaddress.baseLocalPart);
  if (!base.ok) return addressFailure(base.reason);
  if (subaddress.hasTag && !SUBADDRESS_TAG_PATTERN.test(subaddress.tag)) {
    return addressFailure("invalid_local_part");
  }

  return {
    ok: true,
    address,
    localPart,
    domain,
  };
}

export function parseSubaddress(localPart: string): MailSubaddress {
  const plusIndex = localPart.indexOf("+");
  if (plusIndex === -1) {
    return {
      hasTag: false,
      baseLocalPart: localPart,
      tag: null,
    };
  }

  return {
    hasTag: true,
    baseLocalPart: localPart.slice(0, plusIndex),
    tag: localPart.slice(plusIndex + 1),
  };
}

function localPartFailure(reason: Exclude<MailAddressRejectionReason, "invalid_domain" | "invalid_format">) {
  return {
    ok: false,
    reason,
    publicError: "mail_address_unavailable",
  } as const;
}

function addressFailure(reason: MailAddressRejectionReason) {
  return {
    ok: false,
    reason,
    publicError: "mail_address_unavailable",
  } as const;
}
