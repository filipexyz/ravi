/** Test-only fake Console Library (spec `console/library` CLI contract). */

import { createHash } from "node:crypto";

import { ConsoleApiClient } from "../cloud-auth/client.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { LibraryClient, type LibrarySession } from "./client.js";
import { LIBRARY_KIND_SEGMENTS, type LibraryKind } from "./kinds.js";
import { libraryContentHash } from "./package.js";
import type {
  LibraryItem,
  LibraryProposal,
  LibraryProposalComment,
  LibraryProposalStatus,
  LibraryVersionFile,
} from "./types.js";

export const FAKE_CONSOLE_URL = "https://console.test";

export function fakeCredentials(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    version: 1,
    consoleUrl: FAKE_CONSOLE_URL,
    installationId: "inst-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: null,
    scopes: ["console.projects.read", "console.projects.link"],
    user: { id: "user-1", email: "op@example.com", name: "Op" },
    organization: { id: "org-1", slug: "acme", name: "Acme" },
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

export interface FakeLibrarySkill {
  item: LibraryItem;
  files: LibraryVersionFile[];
}

export function fakeSkill(input: {
  slug: string;
  project?: string | null;
  description?: string;
  version?: number;
  externalAllowed?: boolean;
  body?: string;
}): FakeLibrarySkill {
  const content = `---\nname: ${input.slug}\ndescription: ${input.description ?? `About ${input.slug}`}\n---\n\n${input.body ?? `# ${input.slug}\n`}`;
  const files: LibraryVersionFile[] = [
    { path: "SKILL.md", content, bytes: Buffer.byteLength(content), sha256: sha(content) },
    {
      path: "references/guia.md",
      content: "# Guia\n",
      bytes: 7,
      sha256: sha("# Guia\n"),
    },
  ];
  const project = input.project ? { id: `p-${input.project}`, slug: input.project, name: input.project } : null;
  return {
    item: {
      ref: project ? `${project.slug}/${input.slug}` : `org/${input.slug}`,
      kind: "skill",
      scope: project ? "project" : "org",
      project,
      slug: input.slug,
      name: input.slug,
      description: input.description ?? `About ${input.slug}`,
      externalAllowed: input.externalAllowed === true,
      version: input.version ?? 1,
      contentHash: libraryContentHash(files),
      publishedAt: "2026-10-13T00:00:00.000Z",
      publishedBy: { name: "Op" },
      archived: false,
      updatedAt: "2026-10-13T00:00:00.000Z",
    },
    files,
  };
}

/** A published item of any kind with the given files (themes and widgets in tests). */
export function fakeItem(input: {
  kind: LibraryKind;
  slug: string;
  files: Array<{ path: string; content: string }>;
  project?: string | null;
  name?: string;
  description?: string;
  version?: number;
}): FakeLibrarySkill {
  const base = fakeSkill({
    slug: input.slug,
    project: input.project,
    description: input.description,
    version: input.version,
  });
  const files = input.files.map((file) => ({
    ...file,
    bytes: Buffer.byteLength(file.content),
    sha256: sha(file.content),
  }));
  return {
    item: {
      ...base.item,
      kind: input.kind,
      name: input.name ?? input.slug,
      contentHash: libraryContentHash(files),
    },
    files,
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface FakeProposal {
  scope: "org" | "project";
  project: string | null;
  slug: string;
  number: number;
  status: LibraryProposalStatus;
  round: number;
  baseVersion: number;
  name: string;
  description: string;
  externalAllowed: boolean;
  note: string | null;
  files: LibraryVersionFile[];
  author: { name: string | null; agentId: string | null; self: boolean };
  comments: LibraryProposalComment[];
}

export function fakeProposal(
  input: Partial<FakeProposal> & { slug: string; number: number; files?: LibraryVersionFile[] },
): FakeProposal {
  const files = input.files ?? fakeSkill({ slug: input.slug }).files;
  return {
    scope: input.project ? "project" : "org",
    project: input.project ?? null,
    status: "proposed",
    round: 1,
    baseVersion: 0,
    name: input.slug,
    description: `About ${input.slug}`,
    externalAllowed: false,
    note: null,
    author: { name: "Op", agentId: null, self: true },
    comments: [],
    ...input,
    files,
  };
}

export function fakeComment(
  input: Partial<LibraryProposalComment> & { id: string; body: string },
): LibraryProposalComment {
  return {
    parentId: null,
    path: null,
    line: null,
    round: 1,
    outdated: false,
    author: { name: "Ana", agentId: null, self: false },
    createdAt: "2026-10-16T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    can: { resolve: false },
    ...input,
  };
}

/** A route the test answers itself (checked before the Library routes); null passes it on. */
export type FakeRoute = (request: {
  method: string;
  /** Path segments after `/api/cli/library/<segment>`. */
  rest: string[];
  params: URLSearchParams;
  body: unknown;
}) => Response | null;

export interface FakeConsoleOptions {
  /** The kind whose segment the fake serves (default `skill`). */
  kind?: LibraryKind;
  routes?: FakeRoute;
}

export interface FakeConsole {
  skills: FakeLibrarySkill[];
  proposals: FakeProposal[];
  requests: Array<{ method: string; path: string; body?: unknown; authorization?: string | null }>;
  offline: boolean;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake Console answering the Library routes; `offline` makes every call throw like a dead network. */
export function createFakeConsole(
  skills: FakeLibrarySkill[] = [],
  proposals: FakeProposal[] = [],
  options: FakeConsoleOptions = {},
): FakeConsole {
  const kind = options.kind ?? "skill";
  const state: FakeConsole = {
    skills,
    proposals,
    requests: [],
    offline: false,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const headers = new Headers(init?.headers);
      state.requests.push({
        method,
        path: `${parsed.pathname}${parsed.search}`,
        body,
        authorization: headers.get("authorization"),
      });
      if (state.offline) throw new TypeError("fetch failed: connect ECONNREFUSED");
      const root = `/api/cli/library/${LIBRARY_KIND_SEGMENTS[kind]}`;
      if (!parsed.pathname.startsWith(root)) return json(404, { error: { code: "NOT_FOUND", message: "nope" } });
      const rest = parsed.pathname
        .slice(root.length)
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      const project = parsed.searchParams.get("project");
      const custom = options.routes?.({ method, rest, params: parsed.searchParams, body });
      if (custom) return custom;
      const proposalRoute = handleProposalRoute(state, method, rest, parsed.searchParams, body, kind);
      if (proposalRoute) return proposalRoute;
      const inView = (skill: FakeLibrarySkill) =>
        skill.item.scope === "org" || (project !== null && skill.item.project?.slug === project);
      if (method === "GET" && rest.length === 0) {
        const q = (parsed.searchParams.get("q") ?? "").toLowerCase();
        const items = state.skills
          .filter(inView)
          .filter(
            (skill) => !q || skill.item.slug.includes(q.split(" ")[0] ?? "") || skill.files[0]!.content.includes(q),
          )
          .map((skill) => ({ ...skill.item, score: 0.5 }));
        return json(200, { items, query: q, project: project ? { slug: project } : null });
      }
      const show = (skill: FakeLibrarySkill | undefined) =>
        skill
          ? json(200, {
              item: skill.item,
              version: {
                number: skill.item.version,
                note: null,
                contentHash: skill.item.contentHash,
                publishedAt: skill.item.publishedAt,
                files: skill.files,
              },
            })
          : json(404, { error: { code: "NOT_FOUND", message: "Library skill not found." } });
      if (method === "GET" && rest.length === 1) {
        return show(state.skills.find((skill) => skill.item.slug === rest[0] && inView(skill)));
      }
      if (method === "GET" && rest.length === 2) {
        const [scope, slug] = rest as [string, string];
        return show(
          state.skills.find(
            (skill) =>
              skill.item.slug === slug &&
              (scope === "org" ? skill.item.scope === "org" : skill.item.project?.slug === scope),
          ),
        );
      }
      if (method === "POST" && rest.length === 0) {
        const input = body as {
          scope: "org" | "project";
          project?: string;
          slug: string;
          description: string;
          externalAllowed: boolean;
          baseVersion: number;
          files: Array<{ path: string; content: string }>;
        };
        const existing = state.skills.find(
          (skill) =>
            skill.item.slug === input.slug &&
            (input.scope === "org" ? skill.item.scope === "org" : skill.item.project?.slug === input.project),
        );
        const current = existing?.item.version ?? 0;
        if (input.baseVersion !== current) {
          return json(409, {
            error: {
              code: "CONFLICT",
              message: "The published version changed.",
              details: { reason: "stale_base", currentVersion: current },
            },
          });
        }
        const files = input.files.map((file) => ({
          ...file,
          bytes: Buffer.byteLength(file.content),
          sha256: sha(file.content),
        }));
        const contentHash = libraryContentHash(files);
        if (existing && existing.item.contentHash === contentHash) {
          return json(200, {
            item: existing.item,
            version: { number: current, contentHash },
            unchanged: true,
          });
        }
        const next = fakeSkill({
          slug: input.slug,
          project: input.scope === "project" ? (input.project ?? null) : null,
          description: input.description,
          version: current + 1,
          externalAllowed: input.externalAllowed,
        });
        next.files = files;
        next.item.kind = kind;
        next.item.contentHash = contentHash;
        state.skills = [...state.skills.filter((skill) => skill !== existing), next];
        return json(201, { item: next.item, version: { number: next.item.version, contentHash }, unchanged: false });
      }
      return json(404, { error: { code: "NOT_FOUND", message: "nope" } });
    },
  };
  return state;
}

const OPEN_STATUSES = new Set(["draft", "proposed"]);

function conflict(reason: string, details: Record<string, unknown> = {}): Response {
  return json(409, { error: { code: "CONFLICT", message: `Conflict: ${reason}.`, details: { reason, ...details } } });
}

function proposalRef(proposal: Pick<FakeProposal, "scope" | "project" | "slug">): string {
  return `${proposal.scope === "org" ? "org" : proposal.project}/${proposal.slug}`;
}

function serializeProposal(
  state: FakeConsole,
  proposal: FakeProposal,
): Omit<LibraryProposal, "reviewUrl"> & { reviewPath: string } {
  const published = findSkill(state, proposal.scope, proposal.project, proposal.slug);
  const currentVersion = published?.item.version ?? 0;
  const open = OPEN_STATUSES.has(proposal.status);
  return {
    ref: proposalRef(proposal),
    number: proposal.number,
    status: proposal.status,
    round: proposal.round,
    baseVersion: proposal.baseVersion,
    currentVersion,
    stale: open && proposal.baseVersion !== currentVersion,
    publishedVersion: null,
    name: proposal.name,
    description: proposal.description,
    externalAllowed: proposal.externalAllowed,
    note: proposal.note,
    contentHash: libraryContentHash(proposal.files),
    fileCount: proposal.files.length,
    totalBytes: proposal.files.reduce((sum, file) => sum + file.bytes, 0),
    author: proposal.author,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    proposedAt: proposal.status === "draft" ? null : "2026-10-16T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    openComments: proposal.comments.filter((comment) => !comment.parentId && !comment.resolvedAt).length,
    reviewPath: `${proposal.scope === "org" ? "/org/library/org" : `/p/${proposal.project}-id/library/${proposal.project}`}/${proposal.slug}/proposals/${proposal.number}`,
    can: {
      edit: proposal.author.self && open,
      submit: proposal.author.self && proposal.status === "draft",
      withdraw: proposal.author.self && open,
      publish: false,
      reject: false,
    },
  };
}

function findSkill(
  state: FakeConsole,
  scope: "org" | "project",
  project: string | null,
  slug: string,
): FakeLibrarySkill | undefined {
  return state.skills.find(
    (skill) =>
      skill.item.slug === slug && (scope === "org" ? skill.item.scope === "org" : skill.item.project?.slug === project),
  );
}

function itemView(
  state: FakeConsole,
  scope: "org" | "project",
  project: string | null,
  slug: string,
  kind: LibraryKind,
) {
  const published = findSkill(state, scope, project, slug);
  if (published) return published.item;
  const first = state.proposals.find((p) => p.scope === scope && p.project === project && p.slug === slug);
  if (!first) return null;
  return {
    ...fakeSkill({ slug, project }).item,
    kind,
    name: first.name,
    description: first.description,
    version: null,
    contentHash: null,
    publishedAt: null,
    publishedBy: null,
  };
}

function toFiles(files: Array<{ path: string; content: string }>): LibraryVersionFile[] {
  return files.map((file) => ({ ...file, bytes: Buffer.byteLength(file.content), sha256: sha(file.content) }));
}

function unchangedFromPublished(
  published: FakeLibrarySkill | undefined,
  files: LibraryVersionFile[],
  meta: { name: string; description: string; externalAllowed: boolean },
): boolean {
  return Boolean(
    published &&
      published.item.contentHash === libraryContentHash(files) &&
      published.item.name === meta.name &&
      published.item.description === meta.description &&
      published.item.externalAllowed === meta.externalAllowed,
  );
}

/** The proposal routes of the Library contract; null when the request is for another route. */
function handleProposalRoute(
  state: FakeConsole,
  method: string,
  rest: string[],
  params: URLSearchParams,
  body: unknown,
  kind: LibraryKind,
): Response | null {
  if (rest[0] === "proposals" && rest.length === 1) {
    if (method === "GET") {
      const project = params.get("project");
      const wanted = params.get("state") ?? "open";
      const mine = params.get("mine") === "1";
      const proposals = state.proposals
        .filter((p) => p.scope === "org" || !project || p.project === project)
        .filter((p) => wanted === "all" || (wanted === "open") === OPEN_STATUSES.has(p.status))
        .filter((p) => !mine || p.author.self)
        .map((p) => serializeProposal(state, p));
      return json(200, { proposals, state: wanted, project });
    }
    if (method === "POST") {
      const input = body as {
        scope: "org" | "project";
        project?: string;
        slug: string;
        name?: string;
        description: string;
        externalAllowed?: boolean;
        note?: string;
        baseVersion?: number;
        files: Array<{ path: string; content: string }>;
        submit?: boolean;
        agent?: { id: string };
      };
      const projectSlug = input.scope === "project" ? (input.project ?? null) : null;
      const published = findSkill(state, input.scope, projectSlug, input.slug);
      const currentVersion = published?.item.version ?? 0;
      if (input.baseVersion !== undefined && input.baseVersion !== currentVersion) {
        return conflict("stale_base", { currentVersion, baseVersion: input.baseVersion });
      }
      const files = toFiles(input.files);
      const meta = {
        name: input.name ?? input.slug,
        description: input.description,
        externalAllowed: input.externalAllowed ?? false,
      };
      if (unchangedFromPublished(published, files, meta)) return conflict("unchanged");
      const numbers = state.proposals
        .filter((p) => p.scope === input.scope && p.project === projectSlug && p.slug === input.slug)
        .map((p) => p.number);
      const proposal = fakeProposal({
        scope: input.scope,
        project: projectSlug,
        slug: input.slug,
        number: Math.max(0, ...numbers) + 1,
        status: input.submit === true ? "proposed" : "draft",
        baseVersion: currentVersion,
        ...meta,
        note: input.note ?? null,
        files,
        author: { name: "Op", agentId: input.agent?.id ?? null, self: true },
      });
      state.proposals.push(proposal);
      return json(201, { proposal: serializeProposal(state, proposal) });
    }
  }
  if (rest.length < 3 || rest[2] !== "proposals") return null;
  const [scopeRef, slug] = rest as [string, string];
  const scope = scopeRef === "org" ? "org" : "project";
  const project = scope === "org" ? null : scopeRef;
  const item = itemView(state, scope, project, slug, kind);
  if (!item) return json(404, { error: { code: "NOT_FOUND", message: "Library skill not found." } });
  const ofItem = state.proposals
    .filter((p) => p.scope === scope && p.project === project && p.slug === slug)
    .sort((a, b) => b.number - a.number);
  if (rest.length === 3 && method === "GET") {
    return json(200, {
      item,
      can: { propose: true, review: false },
      proposals: ofItem.map((p) => serializeProposal(state, p)),
    });
  }
  const proposal = ofItem.find((p) => String(p.number) === rest[3]);
  if (!proposal) return json(404, { error: { code: "NOT_FOUND", message: "Proposal not found." } });
  if (rest.length === 4 && method === "GET") {
    const published = findSkill(state, scope, project, slug);
    return json(200, {
      item,
      proposal: serializeProposal(state, proposal),
      files: proposal.files,
      base: published && proposal.baseVersion ? { number: proposal.baseVersion, files: published.files } : null,
      comments: proposal.comments,
    });
  }
  if (rest.length === 5 && rest[4] === "update" && method === "POST") {
    const input = body as {
      name?: string;
      description: string;
      externalAllowed?: boolean;
      note?: string;
      baseVersion?: number;
      files: Array<{ path: string; content: string }>;
      submit?: boolean;
    };
    if (!OPEN_STATUSES.has(proposal.status)) return conflict("proposal_closed", { status: proposal.status });
    const published = findSkill(state, scope, project, slug);
    const currentVersion = published?.item.version ?? 0;
    if (input.baseVersion !== undefined && input.baseVersion !== currentVersion) {
      return conflict("stale_base", { currentVersion, baseVersion: input.baseVersion });
    }
    const files = toFiles(input.files);
    const meta = {
      name: input.name ?? proposal.name,
      description: input.description,
      externalAllowed: input.externalAllowed ?? proposal.externalAllowed,
    };
    if (unchangedFromPublished(published, files, meta)) return conflict("unchanged");
    const submitting = input.submit === true && proposal.status === "draft";
    Object.assign(proposal, meta, {
      files,
      note: input.note === undefined ? proposal.note : input.note,
      baseVersion: input.baseVersion ?? proposal.baseVersion,
      round: proposal.status === "proposed" ? proposal.round + 1 : proposal.round,
      status: submitting ? "proposed" : proposal.status,
      comments: proposal.comments.map((comment) => ({
        ...comment,
        outdated: proposal.status === "proposed" ? true : comment.outdated,
      })),
    });
    return json(200, { proposal: serializeProposal(state, proposal) });
  }
  return json(404, { error: { code: "NOT_FOUND", message: "nope" } });
}

/** A session over the fake Console, bound to a project (or none). */
export function fakeSession(
  fake: FakeConsole,
  project: { slug: string; id?: string } | null = null,
  orgId = "org-1",
  kind?: LibraryKind,
): LibrarySession {
  const credentials = fakeCredentials();
  return {
    client: new LibraryClient({
      client: new ConsoleApiClient({ consoleUrl: FAKE_CONSOLE_URL, fetch: fake.fetch }),
      credentials,
      write: () => {},
      delete: () => {},
      ...(kind ? { kind } : {}),
    }),
    consoleUrl: FAKE_CONSOLE_URL,
    orgId,
    project: project ? { ref: project.slug, slug: project.slug, id: project.id ?? `p-${project.slug}` } : null,
  };
}
