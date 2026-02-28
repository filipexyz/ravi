#!/usr/bin/env node
/**
 * docs-link-audit.mjs — Validate internal markdown links in docs/.
 * Reads docs/docs.json for redirects, then checks every [text](link) in .md/.mdx files.
 * Usage: bun scripts/docs-link-audit.mjs
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const DOCS_DIR = join(import.meta.dirname, "..", "docs");
const EXCLUDED = new Set(["assets", ".i18n", "node_modules"]);

// Load redirects from docs.json
let redirects = {};
try {
  const docsJson = JSON.parse(await readFile(join(DOCS_DIR, "docs.json"), "utf8"));
  if (docsJson.redirects) {
    for (const r of docsJson.redirects) {
      redirects[r.source] = r.destination;
    }
  }
} catch {
  // No docs.json or no redirects — fine
}

async function walk(dir) {
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries) {
    if (EXCLUDED.has(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
      files.push(full);
    }
  }
  return files;
}

function extractLinks(content) {
  const links = [];
  const lines = content.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Match [text](link) but skip inline code
    const re = /(?<!`)\[([^\]]*)\]\(([^)]+)\)(?!`)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const href = m[2];
      // Skip external links, anchors, and mailto
      if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("#")) continue;
      links.push({ href, line: i + 1 });
    }
  }
  return links;
}

function resolveLink(href, fromFile) {
  // Strip anchor
  const clean = href.split("#")[0];
  if (!clean) return null; // pure anchor

  const fromDir = dirname(fromFile);

  // Absolute path (starts with /)
  if (clean.startsWith("/")) {
    const target = join(DOCS_DIR, clean);
    return resolveFile(target);
  }

  // Relative path
  const target = resolve(fromDir, clean);
  return resolveFile(target);
}

function resolveFile(target) {
  // Try exact path
  if (existsSync(target)) return true;
  // Try with .md extension
  if (existsSync(target + ".md")) return true;
  // Try with .mdx extension
  if (existsSync(target + ".mdx")) return true;
  // Try as directory with index.md
  if (existsSync(join(target, "index.md"))) return true;
  return false;
}

const files = await walk(DOCS_DIR);
files.sort();

let broken = 0;

for (const file of files) {
  const rel = relative(DOCS_DIR, file);
  const content = await readFile(file, "utf8");
  const links = extractLinks(content);

  for (const { href, line } of links) {
    // Check redirects first
    const cleanHref = href.split("#")[0];
    if (redirects[cleanHref]) continue;

    const resolved = resolveLink(href, file);
    if (resolved === null) continue; // pure anchor
    if (!resolved) {
      console.error(`  BROKEN: ${rel}:${line} → ${href}`);
      broken++;
    }
  }
}

if (broken === 0) {
  console.log(`All links OK (${files.length} files checked).`);
} else {
  console.error(`\n${broken} broken link(s) found.`);
  process.exit(1);
}
