export type MailAddressHeader = {
  name: string;
  value: string;
};

export type MailAddressEntry = {
  address: string;
  name?: string | null;
};

export type MailAddressSummary = {
  schemaVersion: 1;
  bcc: MailAddressEntry[];
  cc: MailAddressEntry[];
  from: MailAddressEntry[];
  internetMessageId?: string | null;
  replyTo: MailAddressEntry[];
  to: MailAddressEntry[];
};

export type MailAddressSummaryInput = {
  bcc?: string[];
  cc?: string[];
  from: string;
  internetMessageId?: string | null;
  replyTo?: string[];
  to: string[];
};

export function mailAddressSummaryFromHeaders(headers: MailAddressHeader[]): MailAddressSummary {
  return {
    schemaVersion: 1,
    from: parseAddressHeader(headerValue(headers, "from")),
    to: parseAddressHeader(headerValue(headers, "to")),
    cc: parseAddressHeader(headerValue(headers, "cc")),
    bcc: parseAddressHeader(headerValue(headers, "bcc")),
    replyTo: parseAddressHeader(headerValue(headers, "reply-to")),
    internetMessageId: headerValue(headers, "message-id") ?? null,
  };
}

export function mailAddressSummaryForOutbound(input: MailAddressSummaryInput): MailAddressSummary {
  return {
    schemaVersion: 1,
    from: parseAddressList([input.from]),
    to: parseAddressList(input.to),
    cc: parseAddressList(input.cc ?? []),
    bcc: parseAddressList(input.bcc ?? []),
    replyTo: parseAddressList(input.replyTo ?? []),
    internetMessageId: input.internetMessageId ?? null,
  };
}

export function serializeMailAddressSummary(summary: MailAddressSummary): string {
  return JSON.stringify(summary);
}

export function parseMailAddressSummary(value: string): MailAddressSummary | null {
  try {
    const parsed = JSON.parse(value) as Partial<MailAddressSummary>;
    if (parsed.schemaVersion !== 1) return null;
    return {
      schemaVersion: 1,
      from: addressEntries(parsed.from),
      to: addressEntries(parsed.to),
      cc: addressEntries(parsed.cc),
      bcc: addressEntries(parsed.bcc),
      replyTo: addressEntries(parsed.replyTo),
      internetMessageId: typeof parsed.internetMessageId === "string" ? parsed.internetMessageId : null,
    };
  } catch {
    return null;
  }
}

export function formatMailAddress(entry: MailAddressEntry): string {
  return entry.name ? `${entry.name} <${entry.address}>` : entry.address;
}

function headerValue(headers: MailAddressHeader[], name: string): string | null {
  const found = headers.find((header) => header.name.toLowerCase() === name);
  return found?.value ?? null;
}

function parseAddressHeader(value: string | null): MailAddressEntry[] {
  return value ? parseAddressList(splitAddressList(value)) : [];
}

function parseAddressList(values: string[]): MailAddressEntry[] {
  return values.flatMap((value) => parseAddressToken(value)).filter((entry): entry is MailAddressEntry => Boolean(entry));
}

function parseAddressToken(value: string): MailAddressEntry | null {
  const token = decodeMimeWords(value).trim();
  if (!token) return null;

  const angleMatch = token.match(/^(.*?)<([^<>@\s]+@[^<>\s]+)>$/);
  if (angleMatch) {
    const name = cleanDisplayName(angleMatch[1] ?? "");
    return {
      address: normalizeAddress(angleMatch[2] ?? ""),
      ...(name ? { name } : {}),
    };
  }

  const emailMatch = token.match(/[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+/);
  if (!emailMatch) return null;
  return {
    address: normalizeAddress(emailMatch[0]),
  };
}

function splitAddressList(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let angleDepth = 0;
  let inQuote = false;

  for (const char of value) {
    if (char === '"' && angleDepth === 0) {
      inQuote = !inQuote;
    } else if (char === "<" && !inQuote) {
      angleDepth += 1;
    } else if (char === ">" && !inQuote && angleDepth > 0) {
      angleDepth -= 1;
    }

    if (char === "," && !inQuote && angleDepth === 0) {
      result.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) result.push(current);
  return result;
}

function cleanDisplayName(value: string): string | null {
  const cleaned = value.trim().replace(/^"+|"+$/g, "").trim();
  return cleaned || null;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function addressEntries(value: unknown): MailAddressEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Partial<MailAddressEntry>;
    if (typeof record.address !== "string" || !record.address.trim()) return [];
    return [
      {
        address: normalizeAddress(record.address),
        ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
      },
    ];
  });
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_match, charset, encoding, encoded) => {
    try {
      const bytes =
        String(encoding).toUpperCase() === "B"
          ? Uint8Array.from(atob(String(encoded)), (char) => char.charCodeAt(0))
          : qDecode(String(encoded));
      return new TextDecoder(String(charset)).decode(bytes);
    } catch {
      return String(encoded);
    }
  });
}

function qDecode(value: string): Uint8Array {
  const normalized = value.replace(/_/g, " ");
  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char?.charCodeAt(0) ?? 0);
    }
  }
  return new Uint8Array(bytes);
}
