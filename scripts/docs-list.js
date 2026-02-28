#!/usr/bin/env node
/**
 * docs-list.js — Walk docs/ and list all .md files with frontmatter summary + read_when.
 * Usage: bun scripts/docs-list.js
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const DOCS_DIR = join(import.meta.dirname, "..", "docs");
const EXCLUDED = new Set(["assets", ".i18n", "node_modules"]);
const EXCLUDED_FILES = new Set(["cross-send-acl.md", "plan-instances.md"]);

async function walk(dir) {
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries) {
    if (EXCLUDED.has(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      files.push(...(await walk(full)));
    } else if ((entry.endsWith(".md") || entry.endsWith(".mdx")) && !EXCLUDED_FILES.has(entry)) {
      files.push(full);
    }
  }
  return files;
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fm[key] = val;
  }
  return fm;
}

const files = await walk(DOCS_DIR);
files.sort();

let errors = 0;

for (const file of files) {
  const rel = relative(DOCS_DIR, file);
  const content = await readFile(file, "utf8");
  const fm = extractFrontmatter(content);

  if (!fm) {
    console.error(`  MISSING frontmatter: ${rel}`);
    errors++;
    continue;
  }

  const summary = fm.summary || fm.description || "(no summary)";

  console.log(`  ${rel}`);
  console.log(`    summary: ${summary}`);
  console.log();
}

console.log(`\n${files.length} doc(s) found, ${errors} error(s).`);
if (errors > 0) process.exit(1);
