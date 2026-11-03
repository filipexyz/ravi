// Publish-time accessibility lint on the template AST (CONTRACT 4.4). What the
// template can get wrong is checked here; what the renderer guarantees (option
// names next to colors, button names with the record title, data-ravi-*
// attributes for agents) is not the template's job.
//
// Buttons, links and colored badges need text every record has: literal text,
// a required field, a field an enclosing `{#if field}` already checked, an
// `{#each}` item, or an `{#if}` with text in both branches. An optional field
// or an `{#if}` without `{:else}` can render them empty.

import { attrOf, literalAttr, WIDGET_TEMPLATE_FILE, type AstAttr, type AstElement, type AstNode, type SourcePosition } from "./parse";
import type { Diagnostic, WidgetFieldSpec, WidgetVariant } from "../types";

const EMPTY_TEXT_HINT = " An optional field or an {#if} without {:else} can leave it empty: add literal text, or put it inside {#if field}.";

/** What is known at a point of the template: the `{#each}` items in scope and the fields an enclosing `{#if}` checked. */
type TextScope = {
  /** Widget fields; without them (manifest errors) any interpolation counts as text. */
  fields: Readonly<Record<string, WidgetFieldSpec>> | null;
  items: ReadonlySet<string>;
  checked: ReadonlySet<string>;
};

export function lintTemplateAccessibility(
  nodes: readonly AstNode[],
  options: { variant: WidgetVariant; fields?: Readonly<Record<string, WidgetFieldSpec>> | null },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (severity: Diagnostic["severity"], code: string, message: string, pos: SourcePosition) => {
    diagnostics.push({ severity, code, message, file: WIDGET_TEMPLATE_FILE, line: pos.line, column: pos.column });
  };
  let previousLevel: number | null = null;

  const visit = (list: readonly AstNode[], scope: TextScope) => {
    for (const node of list) {
      if (node.k === "if") {
        visit(node.then, node.not ? scope : withChecked(scope, node.path));
        visit(node.else, node.not ? withChecked(scope, node.path) : scope);
        continue;
      }
      if (node.k === "each") {
        visit(node.children, { ...scope, items: new Set([...scope.items, node.as]) });
        continue;
      }
      if (node.k !== "el") continue;

      switch (node.piece) {
        case "ravi-image": {
          const alt = attrOf(node, "alt");
          if (!alt) {
            report(
              "error",
              "A11Y_IMAGE_ALT",
              'Give <ravi-image> an alt: a field (alt="{titulo}"), a short text, or alt="decorative" when it adds nothing.',
              node.pos,
            );
          }
          break;
        }
        case "ravi-canvas":
          if (!attrOf(node, "label")) {
            report(
              "error",
              "A11Y_CANVAS_LABEL",
              'Give <ravi-canvas> a label saying what it shows: label="Vendas por mês" or label="{titulo}".',
              node.pos,
            );
          }
          break;
        case "ravi-avatar":
          if (!attrOf(node, "name")) {
            report("error", "A11Y_AVATAR_NAME", 'Give <ravi-avatar> a name="{field}" with the person or name it shows.', node.pos);
          }
          break;
        case "ravi-button":
          if (!hasGuaranteedText(node.children, scope)) {
            const hint = hasText(node.children) ? EMPTY_TEXT_HINT : "";
            report("error", "A11Y_BUTTON_TEXT", `Write the button's text between its tags, e.g. <ravi-button …>Concluir</ravi-button>.${hint}`, node.pos);
          }
          break;
        case "ravi-link": {
          // With no address the renderer draws a plain span, not a link: text
          // only has to hold when `href` has a value, as if it were `{#if href}`.
          const href = attrOf(node, "href")?.value;
          const linkScope = href && "ref" in href ? withChecked(scope, href.ref) : scope;
          if (!hasGuaranteedText(node.children, linkScope)) {
            const hint = hasText(node.children) ? EMPTY_TEXT_HINT : "";
            report("error", "A11Y_LINK_TEXT", `Write the link's text between its tags, saying where it goes.${hint}`, node.pos);
          }
          break;
        }
        case "ravi-badge":
        case "ravi-text": {
          const colored = attrOf(node, "tone") ?? attrOf(node, "color");
          // A badge is a colored shape even when empty; an empty text draws
          // nothing, so it only needs text it can show.
          const ok = node.piece === "ravi-badge" ? hasGuaranteedText(node.children, scope) : hasText(node.children);
          if (colored && !ok) {
            const hint = hasText(node.children) ? EMPTY_TEXT_HINT : "";
            report("error", "A11Y_COLOR_ONLY", `<${node.piece}> with ${colored.name} needs text: color is never the only signal.${hint}`, node.pos);
          }
          break;
        }
        case "ravi-title": {
          const level = Number(literalAttr(node, "level"));
          if (Number.isInteger(level) && level >= 1) {
            if (previousLevel !== null && level > previousLevel + 1) {
              report(
                "error",
                "A11Y_HEADING_SKIP",
                `Heading level ${level} follows level ${previousLevel}; use level="${previousLevel + 1}" or less (or omit level to follow the page).`,
                node.pos,
              );
            }
            previousLevel = level;
          }
          break;
        }
        case "ravi-card":
          if (!hasTitle(node.children)) {
            const compact = options.variant === "compact";
            report(
              compact ? "warning" : "error",
              "A11Y_CARD_TITLE",
              compact
                ? "This compact <ravi-card> has no <ravi-title>; screen readers announce it without a name."
                : "Add a <ravi-title> inside <ravi-card>: its first title names the card for screen readers and agents.",
              node.pos,
            );
          }
          break;
        default:
          break;
      }
      visit(node.children, scope);
    }
  };

  visit(nodes, { fields: options.fields ?? null, items: new Set(), checked: new Set() });
  return diagnostics;
}

function withChecked(scope: TextScope, path: readonly string[]): TextScope {
  const [head] = path;
  if (path.length !== 1 || !head || scope.items.has(head)) return scope;
  return { ...scope, checked: new Set([...scope.checked, head]) };
}

/**
 * Whether `{path}` has a value in every record: an `{#each}` item, a required
 * or already checked field, or a checkbox (always Sim/Não).
 */
function pathHasValue(path: readonly string[], scope: TextScope): boolean {
  const [head = ""] = path;
  if (scope.items.has(head) || scope.checked.has(head)) return true;
  if (!scope.fields) return true;
  const spec = Object.hasOwn(scope.fields, head) ? scope.fields[head] : undefined;
  return Boolean(spec && (spec.required || spec.type === "checkbox"));
}

function attrHasValue(attr: AstAttr | undefined, scope: TextScope): boolean {
  if (!attr) return false;
  return "lit" in attr.value ? attr.value.lit.trim() !== "" : pathHasValue(attr.value.ref, scope);
}

/**
 * Whether the content shows text in every record (see the header): images
 * count by their alt when both `src` and `alt` always have a value, avatars by
 * their name.
 */
function hasGuaranteedText(nodes: readonly AstNode[], scope: TextScope): boolean {
  return nodes.some((node) => {
    switch (node.k) {
      case "text":
        return node.v.trim().length > 0;
      case "expr":
        return pathHasValue(node.path, scope);
      case "if":
        return (
          hasGuaranteedText(node.then, node.not ? scope : withChecked(scope, node.path)) &&
          hasGuaranteedText(node.else, node.not ? withChecked(scope, node.path) : scope)
        );
      case "each":
        return pathHasValue(node.path, scope) && hasGuaranteedText(node.children, { ...scope, items: new Set([...scope.items, node.as]) });
      case "el":
        if (node.piece === "ravi-image") {
          const alt = attrOf(node, "alt");
          const decorative = alt && "lit" in alt.value && alt.value.lit === "decorative";
          return !decorative && attrHasValue(alt, scope) && attrHasValue(attrOf(node, "src"), scope);
        }
        if (node.piece === "ravi-avatar") return attrHasValue(attrOf(node, "name"), scope);
        return hasGuaranteedText(node.children, scope);
    }
  });
}

/**
 * Whether the content can produce text: literal text, an interpolation, an
 * image with a real alt or an avatar with a name, in any branch. Block
 * delimiters themselves are not text.
 */
export function hasText(nodes: readonly AstNode[]): boolean {
  return nodes.some((node) => {
    switch (node.k) {
      case "text":
        return node.v.trim().length > 0;
      case "expr":
        return true;
      case "if":
        return hasText(node.then) || hasText(node.else);
      case "each":
        return hasText(node.children);
      case "el":
        if (node.piece === "ravi-image") {
          const alt = attrOf(node, "alt")?.value;
          return Boolean(alt && !("lit" in alt && alt.lit === "decorative"));
        }
        if (node.piece === "ravi-avatar") return Boolean(attrOf(node, "name"));
        return hasText(node.children);
    }
  });
}

/** A `ravi-title` anywhere inside, except inside a nested card (which it would name instead). */
function hasTitle(nodes: readonly AstNode[]): boolean {
  return nodes.some((node) => {
    switch (node.k) {
      case "if":
        return hasTitle(node.then) || hasTitle(node.else);
      case "each":
        return hasTitle(node.children);
      case "el":
        return node.piece === "ravi-title" || (node.piece !== "ravi-card" && hasTitle((node as AstElement).children));
      default:
        return false;
    }
  });
}
