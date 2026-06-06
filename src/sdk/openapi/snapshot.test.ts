import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { getRegistry } from "../../cli/registry-snapshot.js";
import { emitJson } from "./emit.js";

describe("OpenAPI docs snapshot", () => {
  it("matches the live CLI registry", () => {
    const snapshotPath = resolve("docs/openapi.json");
    const stored = readFileSync(snapshotPath, "utf8");
    const live = `${emitJson(getRegistry())}\n`;

    expect(stored, "docs/openapi.json is stale. Run `ravi sdk openapi emit --out docs/openapi.json`.").toBe(live);
  });
});
