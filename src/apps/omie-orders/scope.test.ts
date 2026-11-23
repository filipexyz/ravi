import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedRaviState, cleanupIsolatedRaviState } from "../../test/ravi-state.js";
import { loadOmieScope } from "./scope.js";
import { SCOPE } from "./test-scope.js";

test("host scope has no installation defaults and refuses invalid configuration", async () => {
  const state = await createIsolatedRaviState("omie-scope-");
  try {
    expect(loadOmieScope).toThrow("Configuração privada");
    mkdirSync(join(state, "integrations"));
    writeFileSync(join(state, "integrations/omie-orders.json"), JSON.stringify({ ...SCOPE, channel: "" }));
    expect(loadOmieScope).toThrow("Configuração privada");
    writeFileSync(join(state, "integrations/omie-orders.json"), JSON.stringify({ ...SCOPE, secret: "synthetic" }));
    expect(loadOmieScope).toThrow("Configuração privada");
  } finally {
    await cleanupIsolatedRaviState(state);
  }
});
test("host reads private scope afresh and freezes the returned binding", async () => {
  const state = await createIsolatedRaviState("omie-scope-");
  try {
    mkdirSync(join(state, "integrations"));
    const path = join(state, "integrations/omie-orders.json");
    writeFileSync(path, JSON.stringify(SCOPE));
    const first = loadOmieScope();
    expect(first).toEqual(SCOPE);
    expect(Object.isFrozen(first)).toBe(true);
    writeFileSync(path, JSON.stringify({ ...SCOPE, connection: "another-example" }));
    expect(loadOmieScope().connection).toBe("another-example");
    expect(first.connection).toBe(SCOPE.connection);
  } finally {
    await cleanupIsolatedRaviState(state);
  }
});
