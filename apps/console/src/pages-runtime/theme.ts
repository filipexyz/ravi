// `ravi.theme`: locale, density, the hash of the theme in `#ravi-theme`, and
// `setMode`. On private routes (`kit.theme.live`) the page asks once per load
// for the project's current theme (`ravi.pages.theme.get`, quiet) and swaps
// the `#ravi-theme` text when the hash differs; errors are ignored and the
// shipped snapshot stays. The runtime does it in `setupTheme`; a file with a
// live theme and no tags gets `theme-live.ts`, which runs `liveTheme` alone.

import { createExec, type ExecClient } from "./exec";
import { readKit } from "./kit";
import type { Rt } from "./runtime";
import { RUNTIME_VERSION } from "./version";

export const THEME_GET_ID = "ravi.pages.theme.get";

export type ThemeMode = "light" | "dark" | "auto";

export type RaviTheme = {
  readonly locale: string;
  readonly density: "comfortable" | "compact";
  readonly hash: string | null;
  setMode(mode: ThemeMode): void;
};

/**
 * One `ravi.pages.theme.get`: swaps the `#ravi-theme` text when the current
 * theme's hash differs from `hash`. Resolves with the hash in place; any
 * error keeps the snapshot, quietly.
 */
export function refreshTheme(doc: Document, exec: ExecClient, hash: string | null): Promise<string | null> {
  return exec.exec(THEME_GET_ID, {}).then(
    (output) => {
      const next = output as { hash?: unknown; css?: unknown } | null;
      if (typeof next?.hash != "string" || typeof next.css != "string" || next.hash == hash) return hash;
      let style = doc.getElementById("ravi-theme");
      if (!style) doc.head.prepend((style = doc.createElement("style")));
      style.id = "ravi-theme";
      style.textContent = next.css;
      style.setAttribute("data-ravi-theme", next.hash);
      return next.hash;
    },
    () => hash,
  );
}

export function setupTheme(rt: Rt): RaviTheme {
  const { doc, kit } = rt;
  const root = doc.documentElement;
  const density = kit.theme?.density == "compact" ? "compact" : "comfortable";
  if (density == "compact" && !root.hasAttribute("data-ravi-density")) root.setAttribute("data-ravi-density", density);
  let hash = doc.getElementById("ravi-theme")?.getAttribute("data-ravi-theme") ?? kit.theme?.hash ?? null;
  if (kit.theme?.live) void refreshTheme(doc, rt.exec, hash).then((next) => (hash = next));
  return {
    locale: rt.locale,
    density,
    get hash() {
      return hash;
    },
    setMode(mode) {
      if (mode == "light" || mode == "dark") root.setAttribute("data-theme", mode);
      else root.removeAttribute("data-theme");
    },
  };
}

/**
 * The theme-live script: once the document is parsed, sets `<html lang>` from
 * the theme when missing and refreshes a live theme as the runtime does
 * (its own exec client: same endpoint, header, retries and budget). Nothing
 * else, and nothing at all when the runtime is on the page (`ravi.version`):
 * the runtime refreshes the theme itself.
 */
export function liveTheme(win: Window & typeof globalThis) {
  const doc = win.document;
  const run = () => {
    if ((win as { ravi?: { version?: unknown } }).ravi?.version) return;
    const kit = readKit(doc);
    const theme = kit.theme;
    if (!theme?.live) return;
    const root = doc.documentElement;
    const locale = theme.locale || kit.locale;
    if (locale && !root.getAttribute("lang")) root.setAttribute("lang", locale);
    const exec = createExec(kit, {
      fetch: (input, init) => win.fetch(input, init),
      sleep: (ms) => new Promise<void>((ok) => win.setTimeout(ok, ms)),
      now: () => Date.now(),
      random: Math.random,
      version: RUNTIME_VERSION,
    });
    void refreshTheme(doc, exec, doc.getElementById("ravi-theme")?.getAttribute("data-ravi-theme") ?? theme.hash);
  };
  if (doc.readyState == "loading") doc.addEventListener("DOMContentLoaded", run);
  else run();
}
