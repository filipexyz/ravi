#!/usr/bin/env bun
/**
 * Generate packaged internal plugins artifact.
 *
 * Source of truth: src/plugins/internal/**.
 * Output: dist/bundle/internal-plugins.json.
 *
 * This file is meant for packaged/NPM builds only. Source/dev runtime reads
 * src/plugins/internal directly so SKILL.md changes do not require a generated
 * registry in the repository.
 */

import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInternalPluginsArtifact } from "../src/plugins/internal-loader.js";

const outputFile = fileURLToPath(new URL("../dist/bundle/internal-plugins.json", import.meta.url));

console.log("Generating packaged internal plugins artifact...");
const artifact = buildInternalPluginsArtifact(outputFile);
console.log(`Generated ${relative(process.cwd(), outputFile)} with ${artifact.plugins.length} plugins`);
