/** Console Library shapes (spec `console/library`, CLI contract). */

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
}
