import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  PAGES_RUNTIME_JS,
  PAGES_RUNTIME_SHA256,
  PAGES_RUNTIME_SOURCE_SHA256,
  PAGES_RUNTIME_VERSION,
  PAGES_THEME_LIVE_JS,
  PAGES_THEME_LIVE_SHA256,
} from "@/server/console/pages/kit/runtime.generated";

import {
  buildPagesRuntime,
  PAGES_RUNTIME_BUILD_INPUTS,
  PAGES_RUNTIME_ENTRY,
  PAGES_RUNTIME_MAX_BYTES,
  PAGES_THEME_LIVE_ENTRY,
  PAGES_THEME_LIVE_MAX_BYTES,
  pagesRuntimeBudgetErrors,
  pagesRuntimeSourceHash,
  type PagesRuntimeBuild,
} from "../../scripts/build-pages-runtime";
import { RUNTIME_VERSION } from "./version";

let fresh: Promise<PagesRuntimeBuild> | null = null;
const freshBuild = () => (fresh ??= buildPagesRuntime());

describe("generated runtime", () => {
  test("is not stale, and a fresh build fits the budgets", async () => {
    const build = await freshBuild();
    expect(build.runtimeInputs).toContain(PAGES_RUNTIME_ENTRY);
    expect(build.themeLiveInputs).toContain(PAGES_THEME_LIVE_ENTRY);
    expect(build.runtimeInputs.some((path) => path.startsWith("src/shared/widgets/render/"))).toBe(true);
    // The theme-live script stays tiny: no renderer, no elements.
    expect(build.themeLiveInputs).toEqual(["errors.ts", "exec.ts", "kit.ts", "theme-live.ts", "theme.ts", "version.ts"].map((name) => `src/pages-runtime/${name}`));
    if (build.sourceSha256 !== PAGES_RUNTIME_SOURCE_SHA256) {
      throw new Error("src/server/console/pages/kit/runtime.generated.ts is stale: run bun run pages:runtime:build");
    }
    expect(pagesRuntimeBudgetErrors(build)).toEqual([]);
  }, 30_000);

  test("the source hash covers the build script and tsconfig.json", async () => {
    const build = await freshBuild();
    expect(PAGES_RUNTIME_BUILD_INPUTS).toEqual(["scripts/build-pages-runtime.ts", "tsconfig.json"]);
    expect(build.sourceSha256).toBe(pagesRuntimeSourceHash([...build.inputs, ...PAGES_RUNTIME_BUILD_INPUTS]));
    expect(build.sourceSha256).not.toBe(pagesRuntimeSourceHash(build.inputs));
  }, 30_000);

  test("version and sha256 match the JS", () => {
    expect(PAGES_RUNTIME_VERSION).toBe(RUNTIME_VERSION);
    expect(PAGES_RUNTIME_VERSION).toBe("1.1.0");
    expect(PAGES_RUNTIME_SHA256).toBe(createHash("sha256").update(PAGES_RUNTIME_JS).digest("hex"));
    expect(PAGES_THEME_LIVE_SHA256).toBe(createHash("sha256").update(PAGES_THEME_LIVE_JS).digest("hex"));
  });

  test("both scripts fit their size budgets and can sit inside a <script>", () => {
    expect(Buffer.byteLength(PAGES_RUNTIME_JS, "utf8")).toBeLessThanOrEqual(PAGES_RUNTIME_MAX_BYTES);
    expect(Buffer.byteLength(PAGES_THEME_LIVE_JS, "utf8")).toBeLessThanOrEqual(PAGES_THEME_LIVE_MAX_BYTES);
    expect(PAGES_RUNTIME_JS).not.toMatch(/<\/script|<!--/i);
    expect(PAGES_THEME_LIVE_JS).not.toMatch(/<\/script|<!--/i);
  });

  test("the bundle boots in a page and keeps ravi.chat", async () => {
    const win = new Window({ url: "https://acme-site.ravi.page/" });
    win.document.write(
      '<!doctype html><html><head><script type="application/json" id="ravi-kit">{"v":1,"runtime":"1.0.0","locale":"pt-BR","theme":null,"widgets":{},"instances":{},"actions":[],"uses":[]}</script></head><body><ravi-widget></ravi-widget></body></html>',
    );
    const chat = { open: () => {} };
    const scope = win as unknown as { ravi: Record<string, unknown> & { ready: Promise<void> }; eval: (code: string) => unknown };
    scope.ravi = { chat } as unknown as typeof scope.ravi;
    scope.eval(PAGES_RUNTIME_JS);
    expect(scope.ravi.chat).toBe(chat);
    expect(scope.ravi.version).toBe("1.1.0");
    expect(win.customElements.get("ravi-view")).toBeDefined();
    await scope.ravi.ready;
    await win.happyDOM.close();
  });
});
