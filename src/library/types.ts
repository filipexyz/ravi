/** Console Library shapes (spec `console/library`, CLI contract). */

import type { LibraryDiagnostic } from "./diagnostics.js";

export interface LibraryProject {
  id: string;
  slug: string;
  name?: string | null;
}

export interface LibraryItem {
  ref: string;
  kind: string;
  scope: "org" | "project";
  project: LibraryProject | null;
  slug: string;
  name: string;
  description: string;
  externalAllowed: boolean;
  version: number;
  contentHash: string;
  publishedAt: string | null;
  publishedBy: { name?: string | null } | null;
  archived: boolean;
  updatedAt: string | null;
}

export interface LibrarySearchItem extends LibraryItem {
  score?: number;
}

export interface LibrarySearchResponse {
  items: LibrarySearchItem[];
  query: string;
  project: unknown;
}

export interface LibraryVersionFile {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface LibraryVersion {
  number: number;
  note: string | null;
  contentHash: string;
  publishedAt: string | null;
  files: LibraryVersionFile[];
}

export interface LibraryShowResponse {
  item: LibraryItem;
  version: LibraryVersion;
}

export interface LibraryPublishBody {
  scope: "org" | "project";
  project?: string;
  slug: string;
  name?: string;
  description: string;
  externalAllowed: boolean;
  note?: string;
  baseVersion: number;
  files: Array<{ path: string; content: string }>;
}

export interface LibraryPublishResponse {
  item: LibraryItem;
  version: { number: number; contentHash: string };
  unchanged: boolean;
  /** Themes and widgets: the compiler's warnings (only when the Console sends them). */
  diagnostics?: LibraryDiagnostic[];
}

// ---------------------------------------------------------------------------
// Drafts and proposals (phase 2)

export type LibraryProposalStatus = "draft" | "proposed" | "published" | "superseded" | "rejected" | "withdrawn";

/** An item as the proposal routes return it: `version` is null while nothing is published. */
export interface LibraryProposalItem extends Omit<LibraryItem, "version" | "contentHash"> {
  version: number | null;
  contentHash: string | null;
}

export interface LibraryProposal {
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
  createdAt: string | null;
  updatedAt: string | null;
  proposedAt: string | null;
  decidedAt: string | null;
  decidedBy: { name: string | null } | null;
  decisionReason: string | null;
  openComments: number;
  /** The proposal's review page in the Console; null when the Console does not report one. */
  reviewUrl: string | null;
  can: { edit: boolean; submit: boolean; withdraw: boolean; publish: boolean; reject: boolean };
}

export interface LibraryProposalComment {
  id: string;
  parentId: string | null;
  path: string | null;
  line: number | null;
  round: number;
  outdated: boolean;
  body: string;
  author: { name: string | null; agentId: string | null; self: boolean };
  createdAt: string | null;
  resolvedAt: string | null;
  resolvedBy: { name: string | null } | null;
  can: { resolve: boolean };
}

export interface LibraryProposalListResponse {
  proposals: LibraryProposal[];
  state: string;
  project: string | null;
}

export interface LibraryItemProposalsResponse {
  item: LibraryProposalItem;
  can: { propose: boolean; review: boolean };
  proposals: LibraryProposal[];
}

export interface LibraryProposalShowResponse {
  item: LibraryProposalItem;
  proposal: LibraryProposal;
  files: LibraryVersionFile[];
  base: { number: number; files: LibraryVersionFile[] } | null;
  comments: LibraryProposalComment[];
}

/** The fields of a proposal's content, shared by create and update. */
export interface LibraryProposalContent {
  name?: string;
  description: string;
  externalAllowed: boolean;
  note?: string;
  /** Create: the version read. Update: only to move the proposal onto the current version. */
  baseVersion?: number;
  files: Array<{ path: string; content: string }>;
  /** `true` proposes (waits for review); otherwise a draft stays a draft. */
  submit?: boolean;
  /** Set when an agent of this Ravi wrote it. */
  agent?: { id: string };
}

export interface LibraryProposalCreateBody extends LibraryProposalContent {
  scope: "org" | "project";
  project?: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Themes and widgets (contract `widgets and org theme`, section 1)

export interface LibraryFileText {
  path: string;
  content: string;
}

export interface LibraryContrastCheck {
  mode: "light" | "dark";
  /** Token paths: foreground, background. */
  pair: [string, string];
  ratio: number;
  min: number;
  ok: boolean;
}

export interface LibraryContrastReport {
  ok: boolean;
  checks: LibraryContrastCheck[];
}

/** `POST themes/check`. */
export interface LibraryThemeCheck {
  ok: boolean;
  diagnostics: LibraryDiagnostic[];
  contrast: LibraryContrastReport | null;
  css: string | null;
}

export interface LibraryWidgetField {
  type: string;
  role: string | null;
  required: boolean;
  label: string | null;
  description: string | null;
}

/** What `widgets check` shows of the compiled widget. */
export interface LibraryWidgetSummary {
  name: string;
  description: string;
  fields: Record<string, LibraryWidgetField>;
  variants: string[];
  actions: number;
  hash: string | null;
}

/** `POST widgets/check`. */
export interface LibraryWidgetCheck {
  ok: boolean;
  diagnostics: LibraryDiagnostic[];
  widget: LibraryWidgetSummary | null;
}

/** `GET widgets/catalog`: the Markdown for agents and the org's widgets. */
export interface LibraryWidgetCatalog {
  text: string;
  widgets: Array<{
    ref: string;
    name: string;
    description: string;
    fields: Record<string, LibraryWidgetField>;
    variants: string[];
  }>;
}

/** `POST widgets/preview`. */
export interface LibraryWidgetPreview {
  html: string;
  diagnostics: LibraryDiagnostic[];
}

/** `GET themes/default` and `POST widgets/scaffold`. */
export interface LibraryGeneratedFiles {
  files: LibraryFileText[];
  diagnostics: LibraryDiagnostic[];
}

export interface LibraryThemePointer {
  ref: string;
  itemId: string;
  scope: "org" | "project";
  slug: string;
  name: string;
  setAt: string | null;
  setBy: string | null;
}

export interface LibraryEffectiveTheme extends LibraryThemePointer {
  version: number;
  hash: string;
  source: "project" | "org";
}

/** `GET themes/active`. */
export interface LibraryThemeActive {
  org: LibraryThemePointer | null;
  project: LibraryThemePointer | null;
  effective: LibraryEffectiveTheme | null;
  warnings: string[];
}

export interface LibraryThemeUsePlan {
  scope: "org" | "project";
  /** The project whose pointer changes, as the Console sends it; null for the org pointer. */
  project: { id: string; slug: string; name: string | null } | null;
  from: LibraryThemePointer | null;
  to: LibraryThemePointer | null;
  affectedHosts: Array<{ siteSlug: string; hostname: string; routes: number }>;
}

/** `POST themes/active`. */
export interface LibraryThemeUseResult {
  plan: LibraryThemeUsePlan;
  applied: boolean;
  /** The pointer already names the target: nothing is (or would be) written. */
  unchanged: boolean;
}

export interface LibraryThemeUseBody {
  scope: "org" | "project";
  project?: string;
  ref: string | null;
  dryRun?: boolean;
}
