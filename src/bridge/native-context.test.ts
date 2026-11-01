import { expect, test } from "bun:test";
import { BridgeStore } from "./store.js";
import { nativeTurnContext } from "./native-context.js";

test("team prompts keep future requests behind their barrier and notes on the shared message boundary", () => {
  const store = new BridgeStore(":memory:");
  try {
    for (const id of ["team", "private"])
      store.db
        .query("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, "e", "u", "p", "a", id, id, id, 0, 1);
    const add = (id: string, role: string, conversation = "team") =>
      store.db.query("INSERT INTO messages VALUES (?,?,?,?,?,?)").run(id, conversation, role, id, id, 1);
    const queue = (id: string, state: string) =>
      store.db
        .query("INSERT INTO queued_messages VALUES (?,?,?,?,?,?,?,?)")
        .run(id, "team", id, "after_reply", state, "{}", 1000, 1);
    add("earlier", "user");
    queue("earlier", "dispatched");
    add("pending-before", "user");
    queue("pending-before", "pending");
    add("note", "user");
    queue("note", "recorded");
    add("current", "user");
    queue("current", "pending");
    add("later", "user");
    queue("later", "pending");
    add("later-note", "user");
    queue("later-note", "recorded");
    add("first-agent-reply", "assistant");
    add("other-private", "assistant", "private");
    store.db.query("INSERT INTO turn_targets VALUES (?,?,?)").run("secondary", "b", "current");
    const context = nativeTurnContext(store, "team", "secondary");
    expect(context.message.text).toBe("current");
    expect(context.notes.map((n) => n.text)).toEqual(["note"]);
    expect(context.history.map((m) => m.text)).toEqual(["earlier", "first-agent-reply"]);
    expect(() => nativeTurnContext(store, "private", "secondary")).toThrow("Missing accepted message");
  } finally {
    store.close();
  }
});
