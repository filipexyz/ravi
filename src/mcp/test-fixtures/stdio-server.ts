/**
 * The gateway tests' stdio MCP server: `bun stdio-server.ts [--legacy-only]
 * [--silent-probe] [--starts <file>]`. `--legacy-only` serves the 2025
 * protocol only (a plain `connect`); otherwise `serveStdio` serves both eras.
 * `--silent-probe` (with `--legacy-only`) never answers `server/discover`,
 * like a legacy server that ignores requests it does not know. `--starts`
 * appends one line per process start, so a test can count spawns.
 *
 * Test-only: no product code imports this module.
 */

import { appendFileSync } from "node:fs";

import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { makeFixtureServer } from "./servers.js";

const args = process.argv.slice(2);
const startsIndex = args.indexOf("--starts");
if (startsIndex >= 0 && args[startsIndex + 1]) {
  appendFileSync(args[startsIndex + 1]!, `${process.pid}\n`);
}

if (args.includes("--legacy-only")) {
  const transport = new StdioServerTransport();
  await makeFixtureServer().connect(transport);
  if (args.includes("--silent-probe")) {
    const handle = transport.onmessage;
    transport.onmessage = (message) => {
      if ((message as { method?: unknown }).method === "server/discover") return;
      handle?.(message);
    };
  }
} else {
  serveStdio(() => makeFixtureServer());
}
