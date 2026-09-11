import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkillSourcePlugins } from "./index.js";

test("discovers source plugins without materializing any internal or user plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "ravi-skill-sources-"));
  const plugin = join(root, "custom");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"custom"}');
  expect(discoverSkillSourcePlugins(root)).toEqual([{ type: "local", path: plugin }]);
  expect(readdirSync(root)).toEqual(["custom"]);
  expect(readdirSync(plugin)).toEqual([".claude-plugin"]);
});

test("source discovery errors cannot become a presumed empty catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "ravi-invalid-skill-sources-"));
  const file = join(root, "not-a-directory");
  writeFileSync(file, "fixture");
  expect(() => discoverSkillSourcePlugins(file)).toThrow();
});
