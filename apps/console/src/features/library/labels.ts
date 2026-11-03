import type { Project } from "@/features/console/types";
import type { Tone } from "@/ui/badge";

import { kindQuery, type LibraryKind } from "./kind";
import type { LibraryProposal } from "./types";

// Words and paths the Library screens share. Every Library link is built
// here, so a change to the Console's URLs is a change to these two paths.

export function libraryBasePath(project: Pick<Project, "id"> | null) {
  return project ? `/p/${project.id}/library` : "/org/library";
}

/** The project list, where a missing project sends people. */
export function projectsPath() {
  return "/projects";
}

/** A Library screen's path: `libraryHref(project, kind, scope, slug, "proposals", "4")`. */
export function libraryHref(project: Pick<Project, "id"> | null, kind: LibraryKind, ...parts: string[]) {
  return `${libraryBasePath(project)}${parts.map((part) => `/${encodeURIComponent(part)}`).join("")}${kindQuery(kind)}`;
}

export function proposalPath(project: Project | null, kind: LibraryKind, ref: string, number: number, ...rest: string[]) {
  const [scope, slug] = ref.split("/") as [string, string];
  return libraryHref(project, kind, scope, slug, "proposals", String(number), ...rest);
}

export function proposalStatus(proposal: LibraryProposal): { label: string; tone: Tone } {
  switch (proposal.status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "proposed":
      return { label: proposal.stale ? "Needs an update" : "Waiting for review", tone: "warn" };
    case "published":
    case "superseded":
      return { label: `Published as v${proposal.publishedVersion}`, tone: "ok" };
    case "rejected":
      return { label: "Rejected", tone: "err" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "neutral" };
  }
}

export function authorLabel(author: { name: string | null; agentId: string | null }) {
  const name = author.name ?? "A member";
  return author.agentId ? `Agent ${author.agentId} for ${name}` : name;
}

