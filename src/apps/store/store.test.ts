import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAppManifests } from "../service.js";
import type { RaviAppManifest } from "../types.js";
import { classifyAppManifest } from "./classify.js";
import { storeExposureFor } from "./gate.js";
import { addBlock, buildIndex, signFile, verifyRepo, writeKeysFile } from "./index-build.js";
import {
  commitChange,
  commitRollback,
  planRollback,
  prepareLocalInstall,
  prepareOfficialInstall,
  prepareOfficialUpdate,
  quarantineBlocked,
  setExposure,
  uninstallApp,
  verifyInstalled,
  type StoreOperationContext,
} from "./install.js";
import { packageTreeHash, readPackageDir } from "./package.js";
import { readReceipt } from "./receipts.js";
import { assertStoreAppRunnable } from "./run-guard.js";
import { loadCachedSource, refreshSource } from "./source.js";
import { ed25519PublicKeyFromPrivatePem } from "./trust.js";
import { AppStoreError } from "./types.js";
import { isAppStatePath } from "../../permissions/provider-config-paths.js";

const BLOG_MANIFEST: RaviAppManifest = {
  schema: "ravi.app/v1",
  id: "blog",
  name: "Blog",
  version: "0.1.0",
  description: "Publish a blog as Ravi Pages routes.",
  interfaces: { cli: { command: "ravi pages", json: true } },
  context: { allow: ["execute:group:pages"] },
  operations: {
    "blog.publish": {
      interface: "cli",
      command: "ravi pages ship --json {args}",
      mutating: true,
      permission: "blog:write",
    },
    "blog.posts": {
      interface: "cli",
      command: "ravi pages published --json {args}",
      mutating: false,
      permission: "blog:read",
    },
  },
  permissions: { required: ["blog:read"], optional: ["blog:write"], mutating: ["blog:write"] },
};

function keyPair(): { pem: string; pub: string } {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { pem, pub: ed25519PublicKeyFromPrivatePem(pem) };
}

function writeApp(dir: string, manifest: RaviAppManifest, extra: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ravi.app.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
}

let work: string;
let repo: string;
let ctx: StoreOperationContext;
let keys: { root: ReturnType<typeof keyPair>; publish: ReturnType<typeof keyPair>; block: ReturnType<typeof keyPair> };
let clock: Date;

function publishRepo(): void {
  buildIndex({ repoDir: repo, now: clock });
  signFile(join(repo, "index.json"), keys.publish.pem);
  if (!existsSync(join(repo, "blocklist.json.sig"))) {
    addBlock({ repoDir: repo, id: "", reason: "", now: clock });
    signFile(join(repo, "blocklist.json"), keys.block.pem);
  }
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ravi-app-store-"));
  repo = join(work, "repo");
  const state = join(work, "state");
  mkdirSync(state, { recursive: true });
  keys = { root: keyPair(), publish: keyPair(), block: keyPair() };
  clock = new Date("2026-11-25T12:00:00Z");
  writeApp(join(repo, "apps", "blog"), BLOG_MANIFEST, { "SKILL.md": "# Blog\n" });
  writeKeysFile({ repoDir: repo, publish: [keys.publish.pub], block: [keys.block.pub], now: clock });
  signFile(join(repo, "keys.json"), keys.root.pem);
  publishRepo();
  ctx = {
    env: { ...process.env, RAVI_STATE_DIR: state },
    source: { id: "official", baseUrl: "https://apps.test/", rootKeys: [keys.root.pub], minSerial: 0 },
    fetcher: async (url) => {
      const path = join(repo, url.replace("https://apps.test/", ""));
      if (!existsSync(path)) throw new AppStoreError("APP_STORE_FETCH_FAILED", `404 ${url}`);
      return new Uint8Array(readFileSync(path));
    },
    now: () => clock,
  };
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function expectStoreError(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    if (typeof promise === "function") await promise();
    else await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppStoreError);
    expect((error as AppStoreError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("classification", () => {
  it("classifies an app that only runs exposed ravi commands as compose", () => {
    const result = classifyAppManifest(BLOG_MANIFEST);
    expect(result.class).toBe("compose");
    expect(result.grants.contextAllow).toEqual(["execute:group:pages"]);
    expect(result.grants.operations["blog.publish"]).toEqual({ runs: "ravi pages ship --json {args}", mutating: true });
  });

  it("treats any other executable, an admin command or an unmarked write as code", () => {
    const shell = classifyAppManifest({
      ...BLOG_MANIFEST,
      operations: { "blog.x": { interface: "cli", command: "bash -c {args}", mutating: true } },
    });
    expect(shell.class).toBe("code");
    const admin = classifyAppManifest({
      ...BLOG_MANIFEST,
      operations: { "blog.x": { interface: "cli", command: "ravi permissions list --json", mutating: false } },
    });
    expect(admin.class).toBe("code");
    expect(admin.reasons.join(" ")).toContain("administration");
    const unmarked = classifyAppManifest({
      ...BLOG_MANIFEST,
      operations: { "blog.x": { interface: "cli", command: "ravi pages ship --json {args}", mutating: false } },
    });
    expect(unmarked.class).toBe("code");
    const omie = classifyAppManifest({
      ...BLOG_MANIFEST,
      operations: { "blog.x": { interface: "builtin", handler: "apps.omie-orders.read" } },
    });
    expect(omie.class).toBe("code");
  });
});

describe("signed source", () => {
  it("verifies keys, index and block list and caches them", async () => {
    const verified = await refreshSource(ctx);
    expect(Object.keys(verified.index.apps)).toEqual(["blog"]);
    expect(loadCachedSource(ctx)?.index.serial).toBe(verified.index.serial);
    expect(verifyRepo(repo, [keys.root.pub], clock).ok).toBe(true);
  });

  it("refuses an index that is not signed by a publication key", async () => {
    signFile(join(repo, "index.json"), keys.block.pem);
    await expectStoreError(refreshSource(ctx), "APP_STORE_SIGNATURE_INVALID");
  });

  it("refuses keys.json signed by anything but a root key", async () => {
    signFile(join(repo, "keys.json"), keys.publish.pem);
    await expectStoreError(refreshSource(ctx), "APP_STORE_SIGNATURE_INVALID");
  });

  it("refuses an older serial and a changed file with the same serial", async () => {
    const before = readFileSync(join(repo, "index.json"));
    const beforeSig = readFileSync(join(repo, "index.json.sig"));
    publishRepo();
    await refreshSource(ctx);
    writeFileSync(join(repo, "index.json"), before);
    writeFileSync(join(repo, "index.json.sig"), beforeSig);
    await expectStoreError(refreshSource(ctx), "APP_STORE_ROLLBACK");
  });

  it("refuses other signed bytes under a serial already accepted", async () => {
    await refreshSource(ctx);
    const index = JSON.parse(readFileSync(join(repo, "index.json"), "utf8"));
    index.apps.blog.description = "same serial, other bytes";
    writeFileSync(join(repo, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    signFile(join(repo, "index.json"), keys.publish.pem);
    await expectStoreError(refreshSource(ctx), "APP_STORE_ROLLBACK");
  });

  it("verifies without saving when asked not to persist", async () => {
    await refreshSource(ctx, { persist: false });
    expect(loadCachedSource(ctx)).toBeNull();
    expect(existsSync(join(ctx.env!.RAVI_STATE_DIR!, "app-store"))).toBe(false);
  });

  it("refuses an expired index", async () => {
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    await expectStoreError(refreshSource(ctx), "APP_STORE_SOURCE_EXPIRED");
  });

  it("is unconfigured without a root key", async () => {
    await expectStoreError(
      refreshSource({ ...ctx, source: { ...ctx.source!, rootKeys: [] } }),
      "APP_STORE_SOURCE_UNCONFIGURED",
    );
  });
});

describe("install lifecycle", () => {
  it("installs from the index, hidden from agents until allowed", async () => {
    const prepared = await prepareOfficialInstall("blog", {}, ctx);
    expect(prepared.plan.class).toBe("compose");
    expect(prepared.plan.exposedTo).toEqual([]);
    const receipt = commitChange(prepared, ctx);
    expect(receipt.treeHash).toBe(packageTreeHash(readPackageDir(join(repo, "apps", "blog"))));

    const blog = discoverAppManifests({ env: ctx.env }).find((record) => record.id === "blog");
    expect(blog?.source).toBe("state");
    expect(blog?.valid).toBe(true);
    expect(storeExposureFor("blog", "dev", ctx.env)).toBe("hidden");
    setExposure("blog", "dev", true, ctx);
    expect(storeExposureFor("blog", "dev", ctx.env)).toBe("exposed");
    expect(storeExposureFor("youtube", "dev", ctx.env)).toBe("not-store");
    expect(() => assertStoreAppRunnable(blog!, ctx.env)).not.toThrow();
    expect(verifyInstalled(undefined, ctx)[0]?.ok).toBe(true);
  });

  it("refuses to run an app whose files changed after install", async () => {
    commitChange(await prepareOfficialInstall("blog", {}, ctx), ctx);
    writeFileSync(join(ctx.env!.RAVI_STATE_DIR!, "apps", "blog", "SKILL.md"), "# changed\n");
    const blog = discoverAppManifests({ env: ctx.env }).find((record) => record.id === "blog")!;
    await expectStoreError(() => assertStoreAppRunnable(blog, ctx.env), "APP_TREE_CHANGED");
  });

  it("ignores a folder dropped into the state apps directory after the store started", async () => {
    const stateApps = join(ctx.env!.RAVI_STATE_DIR!, "apps");
    writeApp(join(stateApps, "early"), { ...BLOG_MANIFEST, id: "early", operations: {} });
    commitChange(await prepareOfficialInstall("blog", {}, ctx), ctx);
    writeApp(join(stateApps, "late"), { ...BLOG_MANIFEST, id: "late", operations: {} });
    const records = discoverAppManifests({ env: ctx.env });
    expect(records.find((record) => record.id === "early")?.errors).toEqual([]);
    const late = records.find((record) => record.id === "late");
    expect(late?.valid).toBe(false);
    expect(late?.errors.join(" ")).toContain("not installed by the app store");
  });

  it("quarantines an installed version once the block list names it", async () => {
    commitChange(await prepareOfficialInstall("blog", {}, ctx), ctx);
    setExposure("blog", "dev", true, ctx);
    addBlock({ repoDir: repo, id: "blog", version: "0.1.0", reason: "test block", now: clock });
    signFile(join(repo, "blocklist.json"), keys.block.pem);
    await refreshSource(ctx);
    expect(quarantineBlocked(ctx)).toEqual(["blog"]);
    expect(readReceipt("blog", ctx.env)?.state).toBe("quarantined");
    expect(storeExposureFor("blog", "dev", ctx.env)).toBe("hidden");
    expect(discoverAppManifests({ env: ctx.env }).find((record) => record.id === "blog")?.valid).toBe(false);
  });

  it("waits a day before an update, keeps exposure when grants match, and rolls back", async () => {
    commitChange(await prepareOfficialInstall("blog", {}, ctx), ctx);
    setExposure("blog", "dev", true, ctx);
    writeApp(join(repo, "apps", "blog"), { ...BLOG_MANIFEST, version: "0.1.1" }, { "SKILL.md": "# Blog v2\n" });
    publishRepo();
    await expectStoreError(prepareOfficialUpdate("blog", {}, ctx), "APP_UPDATE_COOLDOWN");
    clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
    const update = await prepareOfficialUpdate("blog", {}, ctx);
    if ("upToDate" in update) throw new Error("expected an update");
    expect(update.plan.exposedTo).toEqual(["dev"]);
    expect(commitChange(update, ctx).version).toBe("0.1.1");
    const back = commitRollback(planRollback("blog", ctx), ctx);
    expect(back.version).toBe("0.1.0");
    expect(back.previous[0]?.version).toBe("0.1.1");
  });

  it("refuses to republish a version with other files", async () => {
    writeFileSync(join(repo, "apps", "blog", "SKILL.md"), "# sneaky\n");
    expect(() => buildIndex({ repoDir: repo, now: clock })).toThrow(/already published/);
  });

  it("asks for --allow-code before installing a local app that runs other programs", () => {
    const dir = join(work, "local-code");
    writeApp(dir, {
      ...BLOG_MANIFEST,
      id: "local-code",
      operations: { "local-code.run": { interface: "cli", command: "node cli.js {args}", mutating: false } },
      permissions: { required: [], optional: [], mutating: [] },
    });
    expect(() => prepareLocalInstall(dir, {}, ctx)).toThrow(AppStoreError);
    const prepared = prepareLocalInstall(dir, { allowCode: true }, ctx);
    expect(prepared.plan.class).toBe("code");
    commitChange(prepared, ctx);
    expect(uninstallApp("local-code", ctx).id).toBe("local-code");
    expect(readReceipt("local-code", ctx.env)).toBeNull();
  });

  it("keeps listing apps when a state manifest has a non-string id", async () => {
    commitChange(await prepareOfficialInstall("blog", {}, ctx), ctx);
    const broken = join(ctx.env!.RAVI_STATE_DIR!, "apps", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "ravi.app.json"), JSON.stringify({ ...BLOG_MANIFEST, id: 42 }));
    const records = discoverAppManifests({ env: ctx.env });
    expect(records.find((record) => record.id === "blog")?.valid).toBe(true);
    expect(records.find((record) => record.path.startsWith(broken))?.valid).toBe(false);
  });

  it("plans an install without writing store state", async () => {
    await prepareOfficialInstall("blog", { persist: false }, ctx);
    expect(existsSync(join(ctx.env!.RAVI_STATE_DIR!, "app-store"))).toBe(false);
  });

  it("refuses ids nested under or above another app, and folders discovery skips", () => {
    const parent = join(work, "music");
    writeApp(parent, {
      ...BLOG_MANIFEST,
      id: "music",
      operations: {},
      permissions: { required: [], optional: [], mutating: [] },
    });
    commitChange(prepareLocalInstall(parent, {}, ctx), ctx);
    const child = join(work, "player");
    writeApp(child, {
      ...BLOG_MANIFEST,
      id: "music/player",
      operations: {},
      permissions: { required: [], optional: [], mutating: [] },
    });
    expect(() => prepareLocalInstall(child, {}, ctx)).toThrow(/conflicts with the app music/);
    const skipped = join(work, "coverage");
    writeApp(skipped, {
      ...BLOG_MANIFEST,
      id: "coverage",
      operations: {},
      permissions: { required: [], optional: [], mutating: [] },
    });
    expect(() => prepareLocalInstall(skipped, {}, ctx)).toThrow(/discovery skips/);
  });

  it("refuses an id another source already declares", async () => {
    await expectStoreError(prepareOfficialInstall("youtube", {}, ctx), "APP_ID_CONFLICT");
  });
});

describe("protected paths", () => {
  it("treats the state apps and app-store folders as protected", () => {
    const state = ctx.env!.RAVI_STATE_DIR!;
    const previous = process.env.RAVI_STATE_DIR;
    process.env.RAVI_STATE_DIR = state;
    try {
      expect(isAppStatePath(join(state, "apps", "blog", "ravi.app.json"))).toBe(true);
      expect(isAppStatePath(join(state, "app-store", "receipts", "blog.json"))).toBe(true);
      expect(isAppStatePath(join(work, "elsewhere.txt"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RAVI_STATE_DIR;
      else process.env.RAVI_STATE_DIR = previous;
    }
  });
});
