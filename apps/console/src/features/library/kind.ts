"use client";

import { useSearchParams } from "next/navigation";

// The Library holds four kinds of items: skills, agent definitions, themes
// and widgets. Screens read the kind from `?kind=agent|theme|widget` (skills
// when absent) and every link they build carries it on.

export const LIBRARY_KINDS = ["skill", "agent", "theme", "widget"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/** Themes and widgets compile with the shared widgets engine; skills and agents are plain text. */
export type CompiledKind = Extract<LibraryKind, "theme" | "widget">;

/** The kind a `?kind=` value names; skills for anything else. */
export function parseLibraryKind(value: string | null | undefined): LibraryKind {
  return LIBRARY_KINDS.find((kind) => kind === value) ?? "skill";
}

export function isCompiledKind(kind: LibraryKind): kind is CompiledKind {
  return kind === "theme" || kind === "widget";
}

export function useLibraryKind(): LibraryKind {
  return parseLibraryKind(useSearchParams().get("kind"));
}

// Skill and agent screens are in English like the rest of the Console; the
// theme and widget words are PT-BR, as the product copy for those kinds is.
export const KIND_WORDS = {
  skill: {
    one: "skill",
    many: "skills",
    One: "Skill",
    Many: "Skills",
    entry: "SKILL.md",
    segment: "skills",
    create: "New skill",
    search: "Search skills",
    none: "No skills yet",
    noMatch: "No skills match",
    loadError: "This skill couldn't load",
    fresh: "A new skill",
    cantPropose: "You can't propose skills here",
  },
  agent: {
    one: "agent",
    many: "agents",
    One: "Agent",
    Many: "Agents",
    entry: "AGENTS.md",
    segment: "agents",
    create: "New agent",
    search: "Search agents",
    none: "No agents yet",
    noMatch: "No agents match",
    loadError: "This agent couldn't load",
    fresh: "A new agent",
    cantPropose: "You can't propose agents here",
  },
  theme: {
    one: "tema",
    many: "temas",
    One: "Tema",
    Many: "Temas",
    entry: "theme.json",
    segment: "themes",
    create: "Novo tema",
    search: "Buscar temas",
    none: "Nenhum tema ainda",
    noMatch: "Nenhum tema encontrado",
    loadError: "Não deu para abrir este tema",
    fresh: "Um tema novo",
    cantPropose: "Você não pode propor temas aqui",
  },
  widget: {
    one: "widget",
    many: "widgets",
    One: "Widget",
    Many: "Widgets",
    entry: "widget.html",
    segment: "widgets",
    create: "Novo widget",
    search: "Buscar widgets",
    none: "Nenhum widget ainda",
    noMatch: "Nenhum widget encontrado",
    loadError: "Não deu para abrir este widget",
    fresh: "Um widget novo",
    cantPropose: "Você não pode propor widgets aqui",
  },
} as const satisfies Record<LibraryKind, Record<string, string>>;

export function kindQuery(kind: LibraryKind) {
  return kind === "skill" ? "" : `?kind=${kind}`;
}
