import type { Diagnostic, WidgetScriptAudit, WidgetScriptRef } from "@/shared/widgets/types";

import type { LibraryKind } from "./kind";

export type LibraryItem = {
  ref: string;
  kind: LibraryKind;
  scope: "org" | "project";
  project: { id: string; slug: string; name: string } | null;
  slug: string;
  name: string;
  description: string;
  externalAllowed: boolean;
  version: number | null;
  contentHash: string | null;
  publishedAt: string | null;
  publishedBy: { name: string | null } | null;
  archived: boolean;
  updatedAt: string;
  score?: number;
};

export type LibraryFile = { path: string; content: string; bytes: number; sha256: string };

export type LibraryItemVersion = {
  number: number;
  status: string;
  note: string | null;
  contentHash: string;
  publishedAt: string | null;
  files: LibraryFile[];
  /** An agent definition's parsed `agent.json`; absent for skills. */
  agent?: LibraryAgentManifest | null;
  /** Widgets: widget.js (sha256 and size), or null without code. */
  script?: WidgetScriptRef | null;
  /** Widgets with code: the stored accessibility audit, or null before one ran. */
  scriptAudit?: WidgetScriptAudit | null;
  /** Widgets: true without code, or when the stored audit passes for this widget.js. Pages refuse a version where it is false. */
  scriptAudited?: boolean;
  /** Widgets with code: whether the viewer (an org owner or admin) may run and store the audit. */
  canAudit?: boolean;
};

export type LibraryAgentManifest = {
  provider: string | null;
  model: string | null;
  profile: string | null;
  skills: string[];
};

export type LibraryVersionSummary = {
  number: number;
  status: string;
  note: string | null;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  publishedAt: string | null;
  publishedBy: { name: string | null } | null;
};

export type LibraryCan = { propose: boolean; review: boolean };

export type LibraryProposalStatus = "draft" | "proposed" | "published" | "superseded" | "rejected" | "withdrawn";

export type LibraryProposal = {
  ref: string;
  number: number;
  status: LibraryProposalStatus;
  round: number;
  baseVersion: number;
  currentVersion: number;
  stale: boolean;
  publishedVersion: number | null;
  name: string;
  description: string;
  externalAllowed: boolean;
  note: string | null;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  author: { name: string | null; agentId: string | null; self: boolean };
  createdAt: string;
  updatedAt: string;
  proposedAt: string | null;
  decidedAt: string | null;
  decidedBy: { name: string | null } | null;
  decisionReason: string | null;
  openComments: number;
  reviewPath: string;
  can: { edit: boolean; submit: boolean; withdraw: boolean; publish: boolean; reject: boolean };
};

export type LibraryComment = {
  id: string;
  parentId: string | null;
  path: string | null;
  line: number | null;
  round: number;
  outdated: boolean;
  body: string;
  author: { name: string | null; agentId: string | null; self: boolean };
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: { name: string | null } | null;
  can: { resolve: boolean };
};

export type LibraryProposalDetail = {
  item: LibraryItem;
  proposal: LibraryProposal;
  files: LibraryFile[];
  base: { number: number; files: LibraryFile[] } | null;
  comments: LibraryComment[];
};

export type LibraryProposalInput = {
  name?: string;
  /** Required for skills and agents; themes and widgets take it from their files when absent. */
  description?: string;
  externalAllowed: boolean;
  note?: string;
  baseVersion?: number;
  files: { path: string; content: string }[];
  submit: boolean;
};

export type LibraryPin = {
  id: string;
  installation: { id: string; name: string };
  agent: { id: string; name: string; project: { id: string; slug: string; name: string } | null; reported: boolean };
  pinnedBy: { name: string } | null;
  createdAt: string;
};

export type LibraryInstallation = {
  id: string;
  name: string;
  lastSeenAt: string | null;
  agents: { id: string; name: string; provider: string | null; model: string | null; reportedAt: string }[];
};

export type DirectoryAgent = {
  installation: { id: string; name: string };
  agent: {
    id: string;
    name: string;
    description: string | null;
    provider: string | null;
    model: string | null;
    project: { id: string; slug: string; name: string } | null;
  };
  online: boolean;
  acceptsRequests: boolean;
  reportedAt: string;
  self: boolean;
};

// ---------------------------------------------------------------------------
// Themes and widgets

/** A theme pointer, described by the theme item it names (`scope` is the item's). */
export type ThemePointer = {
  ref: string;
  itemId: string;
  scope: "org" | "project";
  slug: string;
  name: string;
  setAt: string | null;
  setBy: { name: string | null } | null;
};

export type EffectiveThemePointer = ThemePointer & { version: number; hash: string; source: "project" | "org" };

/** `GET themes/active?project=`. */
export type ActiveThemes = {
  org: ThemePointer | null;
  project: ThemePointer | null;
  effective: EffectiveThemePointer | null;
  warnings: string[];
  can?: { setOrg: boolean; setProject: boolean };
};

export type ThemePointerPlan = {
  scope: "org" | "project";
  project: { id: string; slug: string; name: string } | null;
  from: ThemePointer | null;
  to: ThemePointer | null;
  affectedHosts: { siteSlug: string; hostname: string; routes: number }[];
};

/** `POST themes/active`. */
export type ThemePointerResult = { plan: ThemePointerPlan; applied: boolean; unchanged?: boolean };

/** One widget of `GET widgets/catalog` (the shared engine's `CatalogWidget`). */
export type CatalogWidgetSummary = {
  ref: string;
  name: string;
  description: string;
};

/** `POST widgets/scaffold`. */
export type WidgetScaffold = { files: { path: string; content: string }[]; diagnostics: Diagnostic[] };
