import { describe, expect, test } from "bun:test";

import { createGoogleAdapter, GOOGLE_WRITE_SCOPES } from "./adapters/google";
import {
  computeRequestedScopes,
  connectionAccessMode,
  deriveAccessMode,
  parseAccessMode,
  scopesToStore,
} from "./scopes";

const google = createGoogleAdapter({
  config: { clientId: "client", clientSecret: "secret" },
  capabilities: new Map(),
});

const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
const DRIVE = "https://www.googleapis.com/auth/drive";
const IDENTITY = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

describe("connect scopes", () => {
  test("always requests the identity scopes", () => {
    const scopes = computeRequestedScopes(google, { accessMode: "full" });
    expect(scopes.slice(0, 3)).toEqual(IDENTITY);
    expect(scopes).toContain(GMAIL_READ);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  test("full access uses the default scopes including gmail.send", () => {
    const scopes = computeRequestedScopes(google, { accessMode: "full" });
    expect(scopes).toContain(GMAIL_SEND);
    for (const scope of IDENTITY) expect(scopes).toContain(scope);
  });

  test("read only drops every write scope", () => {
    const scopes = computeRequestedScopes(google, { accessMode: "read_only" });
    expect(scopes).not.toContain(GMAIL_SEND);
    for (const scope of GOOGLE_WRITE_SCOPES) expect(scopes).not.toContain(scope);
    expect(scopes).toContain(GMAIL_READ);
    expect(scopes).toContain("openid");
  });

  test("read only stores only what it requested, never a write scope granted earlier", () => {
    const requested = computeRequestedScopes(google, { accessMode: "read_only" });
    const granted = [...requested, GMAIL_SEND, "https://mail.google.com/", DRIVE];
    const stored = scopesToStore(google, { granted, requested, accessMode: "read_only" });
    expect(stored).toEqual(requested);
    // Nothing reported as granted: the request itself, still without writes.
    expect(scopesToStore(google, { granted: [], requested, accessMode: "read_only" })).toEqual(requested);
    // A scope the account left unchecked stays out.
    const partial = requested.filter((scope) => scope !== CALENDAR_READ);
    expect(scopesToStore(google, { granted: partial, requested, accessMode: "read_only" })).not.toContain(
      CALENDAR_READ,
    );
  });

  test("full access stores what the provider granted", () => {
    const requested = computeRequestedScopes(google, { accessMode: "full" });
    const granted = [...requested, DRIVE];
    expect(scopesToStore(google, { granted, requested, accessMode: "full" })).toEqual(granted);
  });

  test("access mode is derived from the granted scopes", () => {
    expect(deriveAccessMode([...IDENTITY, GMAIL_READ], GOOGLE_WRITE_SCOPES)).toBe("read_only");
    expect(deriveAccessMode([GMAIL_READ, GMAIL_SEND], GOOGLE_WRITE_SCOPES)).toBe("full");
    expect(deriveAccessMode([], GOOGLE_WRITE_SCOPES)).toBe("read_only");
  });

  test("a connection recorded as read only stays read only whatever its scopes", () => {
    expect(
      connectionAccessMode({ scopesJson: [GMAIL_READ, GMAIL_SEND], metadataJson: { accessMode: "read_only" } }, GOOGLE_WRITE_SCOPES),
    ).toBe("read_only");
    expect(connectionAccessMode({ scopesJson: [GMAIL_READ, GMAIL_SEND], metadataJson: {} }, GOOGLE_WRITE_SCOPES)).toBe(
      "full",
    );
    expect(
      connectionAccessMode({ scopesJson: [GMAIL_READ], metadataJson: { accessMode: "full" } }, GOOGLE_WRITE_SCOPES),
    ).toBe("read_only");
  });

  test("parses access modes strictly", () => {
    expect(parseAccessMode("full")).toBe("full");
    expect(parseAccessMode("read_only")).toBe("read_only");
    expect(parseAccessMode("readonly")).toBeNull();
    expect(parseAccessMode(undefined)).toBeNull();
  });
});
