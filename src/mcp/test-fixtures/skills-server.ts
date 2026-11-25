/**
 * A skills server fixture (spec mcp, Remote Skills), built with
 * `@modelcontextprotocol/server` 2.4.0 and its skills extension over HTTP
 * (both protocol eras). It records every method, can change its files (a new
 * manifest, or none: an unpublished skill, or a Console whose skills switch
 * is off), serve bytes that do not match its manifest, add a Library
 * reference to its entries the way the Console does, and split its listing
 * into an empty first page and a second one.
 *
 * Test-only: no product code imports this module.
 */

import { serve } from "bun";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { memorySkillFiles, type SkillCatalog, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";

export const FIXTURE_SKILL_FILES: Record<string, string> = {
  "weekly-report/SKILL.md":
    "---\nname: weekly-report\ndescription: Write the weekly report.\n---\n# Weekly report\nSee references/GUIDE.md. Café ☕\n",
  "weekly-report/references/GUIDE.md": "# Guide\nUse short sentences.\n",
  "pdf-forms/SKILL.md": "---\nname: pdf-forms\ndescription: Fill PDF forms\n---\n# PDF forms\n",
};

/** The URI prefix of the fixture's skills: `skill://project/prs/<skill>/...`. */
export const FIXTURE_SKILL_PREFIX = "project/prs";

export function fixtureSkillUri(skill: string, file = "SKILL.md"): string {
  return `skill://${FIXTURE_SKILL_PREFIX}/${skill}/${file}`;
}

export interface SkillsFixture {
  url: string;
  /** JSON-RPC methods seen, in order. */
  methods: string[];
  /** `resources/read` URIs seen, in order. */
  reads: string[];
  /** Serve these files from now on (a new manifest). */
  setFiles(files: Record<string, string>): Promise<void>;
  /** Serve `resources/read` text for this URI with an extra character (bytes that miss the manifest). */
  tamper(uri: string | null): void;
  /** Add `_meta["bot.ravi/library"].ref` to every entry for this skill URI. */
  libraryRef(uri: string, ref: string | null): void;
  /** Answer the entry of this skill URI with a dynamic resource list. */
  dynamic(uri: string | null): void;
  /**
   * Answer these methods with an HTTP error before the server sees them:
   * `insufficient_scope` (403 with the step-up challenge naming the skills
   * scope, as a Console answers without it) or `rate_limited` (429). Null
   * clears it.
   */
  refuse(methods: string[] | null, kind?: "insufficient_scope" | "rate_limited"): void;
  /** Answer the first `skills/list` page empty with a cursor; the second page holds every skill. */
  emptyFirstPage(on: boolean): void;
  /** Never answer these methods (null clears it); `hanging` counts the requests held, `abandoned` those the client aborted. */
  hang(methods: string[] | null): void;
  readonly hanging: { held: number; abandoned: number };
  close(): Promise<void>;
}

async function loadCatalog(files: Record<string, string>): Promise<SkillCatalog> {
  return SkillsExtension.load(memorySkillFiles(files), {
    prefix: FIXTURE_SKILL_PREFIX,
    cacheHint: { ttlMs: 0, cacheScope: "private" },
    onWarning: () => {},
  });
}

type Json = Record<string, unknown>;

const SECOND_PAGE_CURSOR = "fixture-page-2";

function rewriteEntry(entry: unknown, refs: Map<string, string>, dynamicUri: string | null): void {
  if (!entry || typeof entry !== "object") return;
  const record = entry as Json;
  if (dynamicUri !== null && record.uri === dynamicUri) record.resources = "dynamic";
  const ref = typeof record.uri === "string" ? refs.get(record.uri) : undefined;
  if (ref) record._meta = { ...((record._meta as Json | undefined) ?? {}), "bot.ravi/library": { ref, version: 3 } };
}

export async function startSkillsFixture(files: Record<string, string> = FIXTURE_SKILL_FILES): Promise<SkillsFixture> {
  let catalog = await loadCatalog(files);
  let tampered: string | null = null;
  let dynamicUri: string | null = null;
  let refused: { methods: Set<string>; kind: "insufficient_scope" | "rate_limited" } | null = null;
  let splitPages = false;
  let hung: Set<string> | null = null;
  const hanging = { held: 0, abandoned: 0 };
  const refs = new Map<string, string>();
  const methods: string[] = [];
  const reads: string[] = [];
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: "skills-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.registerTool("noop", { description: "Does nothing" }, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      catalog.attach(mcp);
      return mcp;
    },
    { onerror: () => {} },
  );

  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(request) {
      let body: Json | null = null;
      if (request.method === "POST") {
        try {
          body = (await request.clone().json()) as Json;
        } catch {
          // no-cause: a body that is not JSON is recorded as no method; the handler answers it.
          body = null;
        }
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method) methods.push(method);
      const params = (body?.params as Json | undefined) ?? {};
      if (method === "resources/read" && typeof params.uri === "string") reads.push(params.uri);
      if (hung?.has(method)) {
        hanging.held++;
        request.signal.addEventListener("abort", () => hanging.abandoned++, { once: true });
        return new Promise<Response>(() => {});
      }
      if (refused?.methods.has(method)) {
        if (refused.kind === "rate_limited") {
          return new Response('{"error":"mcp_rate_limited"}', {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "30" },
          });
        }
        return new Response('{"error":"insufficient_scope"}', {
          status: 403,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Bearer error="insufficient_scope", scope="mcp.console.skills.read"',
          },
        });
      }
      let forwarded = request;
      if (method === "skills/list" && splitPages && params.cursor === SECOND_PAGE_CURSOR && body) {
        // The second page is the server's whole (one-page) listing: the cursor is dropped before it sees it.
        const { cursor: _cursor, ...rest } = params;
        forwarded = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ ...body, params: rest }),
        });
      }
      const firstPageEmpty = method === "skills/list" && splitPages && params.cursor === undefined;
      const response = await handler.fetch(forwarded);
      const rewrite =
        firstPageEmpty ||
        (method === "resources/read" && tampered !== null && params.uri === tampered) ||
        ((method === "skills/list" || method === "skills/get") && (refs.size > 0 || dynamicUri !== null));
      if (!rewrite) return response;
      const type = response.headers.get("content-type") ?? "";
      const text = await response.text();
      const change = (message: Json): Json => {
        const result = message.result as Json | undefined;
        if (!result) return message;
        if (method === "resources/read") {
          for (const content of (result.contents as Json[] | undefined) ?? []) {
            if (typeof content.text === "string") content.text = `${content.text}!`;
          }
        } else if (method === "skills/list") {
          if (firstPageEmpty) {
            result.skills = [];
            result.nextCursor = SECOND_PAGE_CURSOR;
          }
          for (const entry of (result.skills as unknown[] | undefined) ?? []) rewriteEntry(entry, refs, dynamicUri);
        } else {
          rewriteEntry(result.skill, refs, dynamicUri);
        }
        return message;
      };
      let out: string;
      if (type.includes("text/event-stream")) {
        out = text
          .split("\n")
          .map((line) =>
            line.startsWith("data: ") ? `data: ${JSON.stringify(change(JSON.parse(line.slice(6))))}` : line,
          )
          .join("\n");
      } else {
        out = JSON.stringify(change(JSON.parse(text) as Json));
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(out, { status: response.status, headers });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    methods,
    reads,
    async setFiles(next) {
      catalog = await loadCatalog(next);
    },
    tamper(uri) {
      tampered = uri;
    },
    dynamic(uri) {
      dynamicUri = uri;
    },
    emptyFirstPage(on) {
      splitPages = on;
    },
    hang(methods) {
      hung = methods === null ? null : new Set(methods);
    },
    hanging,
    refuse(methods, kind = "insufficient_scope") {
      refused = methods === null ? null : { methods: new Set(methods), kind };
    },
    libraryRef(uri, ref) {
      if (ref === null) refs.delete(uri);
      else refs.set(uri, ref);
    },
    async close() {
      await handler.close();
      server.stop(true);
    },
  };
}
