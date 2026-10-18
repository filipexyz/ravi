import { describe, expect, it } from "bun:test";
import type { ConnectorTurnResult } from "../../link/connector-turn.js";
import { resolveSlackThreadRequester } from "./thread-requester.js";

const contacts: Record<string, string | null> = {
  "ct-ana": "Ana Souza",
  "ct-owner": "Luís",
  "ct-nameless": null,
};

function requester(result: ConnectorTurnResult | (() => never), ownerName: string | null = "Luís Filipe") {
  return resolveSlackThreadRequester({
    resolveTurn: typeof result === "function" ? result : () => result,
    contactName: (id) => contacts[id],
    ownerName: () => ownerName,
  });
}

function blocked(extra: Partial<Extract<ConnectorTurnResult, { ok: false }>>): ConnectorTurnResult {
  return { ok: false, error: new Error("blocked") as never, actorPrincipal: "unknown", ...extra };
}

describe("Slack thread requester", () => {
  it("names the contact who wrote the turn", () => {
    expect(
      requester({
        ok: true,
        turn: {
          speaker: { kind: "contact", contactId: "ct-ana" },
          conversation: "dm",
          actorPrincipal: "contact:ct-ana",
        },
      }),
    ).toBe("Ana Souza");
  });

  it("names a writer whose turn Console calls refuse, from the candidate or the principal", () => {
    expect(
      requester(
        blocked({
          actorPrincipal: "contact:ct-ana",
          candidate: {
            speaker: { kind: "contact", contactId: "ct-ana" },
            conversation: "group",
            actorPrincipal: "contact:ct-ana",
          },
        }),
      ),
    ).toBe("Ana Souza");
    expect(requester(blocked({ actorPrincipal: "contact:ct-ana" }))).toBe("Ana Souza");
  });

  it("names the operator by their own contact, then by the owner contact", () => {
    expect(
      requester({
        ok: true,
        turn: {
          speaker: { kind: "owner", contactId: "ct-owner" },
          conversation: "dm",
          actorPrincipal: "contact:ct-owner",
        },
      }),
    ).toBe("Luís");
    expect(
      requester({
        ok: true,
        turn: {
          speaker: { kind: "owner", contactId: "ct-nameless" },
          conversation: "dm",
          actorPrincipal: "contact:ct-nameless",
        },
      }),
    ).toBe("Luís Filipe");
    expect(
      requester({
        ok: true,
        turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" },
      }),
    ).toBe("Luís Filipe");
    expect(requester(blocked({ speakerIsOwner: true }))).toBe("Luís Filipe");
  });

  it("names nobody for an agent, a routine, an unknown turn or a failed lookup", () => {
    expect(
      requester(blocked({ actorPrincipal: "agent:main", candidate: undefined, relay: undefined }), "Luís"),
    ).toBeUndefined();
    expect(
      requester(
        { ok: true, turn: { speaker: { kind: "automation" }, conversation: "group", actorPrincipal: "trigger:t1" } },
        "Luís",
      ),
    ).toBeUndefined();
    expect(requester(blocked({}), "Luís")).toBeUndefined();
    expect(
      requester(() => {
        throw new Error("db closed");
      }),
    ).toBeUndefined();
    expect(
      requester(
        { ok: true, turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" } },
        null,
      ),
    ).toBeUndefined();
  });
});
