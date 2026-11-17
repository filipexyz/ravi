/** Independent synthetic filesystem and DNS boundary, installed before the guard under test. */
import { mock } from "bun:test";
import { join, resolve } from "node:path";
import { installRetainedDnsSentinels } from "./retained-preload-dns-sentinels.js";

const state = process.env.PR795_RETAINED_STATE;
const evidence = process.env.PR795_RUN_EVIDENCE;
if (!state || !evidence) throw new Error("Contract probes require retained synthetic roots");
const nativeFs = { ...(await import("node:fs")) };
const nativePromises = { ...(await import("node:fs/promises")) };
const nativeOs = { ...(await import("node:os")) };
const home = join(state, "synthetic-home");
nativeFs.mkdirSync(home, { recursive: true });
const privateRoot = join(home, ".ssh");
const resolvedPrivateRoot = join(state, "virtual-private-target");
const outside = "/__ravi_retained_virtual__/readonly.txt";
const calls: Array<{ operation: string; path: string }> = [];
const pathOf = (value: unknown) => (typeof value === "string" ? resolve(value) : "");
const isPrivate = (path: string) => path === privateRoot || path.startsWith(`${privateRoot}/`);
const isVirtual = (path: string) =>
  isPrivate(path) || path === resolvedPrivateRoot || path.startsWith(`${resolvedPrivateRoot}/`) || path === outside;
const fs = {
  ...nativeFs,
  existsSync(path: unknown) {
    return isVirtual(pathOf(path)) || nativeFs.existsSync(path as string);
  },
  realpathSync(path: unknown) {
    const value = pathOf(path);
    if (isPrivate(value)) return value.replace(privateRoot, resolvedPrivateRoot);
    if (isVirtual(value)) return value;
    return nativeFs.realpathSync(path as string);
  },
  readFileSync(path: unknown, ...args: unknown[]) {
    if (isVirtual(pathOf(path))) {
      calls.push({ operation: "read", path: pathOf(path) });
      return "SYNTHETIC_SENTINEL";
    }
    return Reflect.apply(nativeFs.readFileSync, nativeFs, [path, ...args]);
  },
  linkSync(source: unknown, _destination: unknown) {
    calls.push({ operation: "linkSync", path: pathOf(source) });
  },
  link(source: unknown, _destination: unknown, callback: (error: Error | null) => void) {
    calls.push({ operation: "link", path: pathOf(source) });
    queueMicrotask(() => callback(null));
  },
};
const promises = {
  ...nativePromises,
  async link(source: unknown, _destination: unknown) {
    calls.push({ operation: "promises.link", path: pathOf(source) });
  },
};
mock.module("node:os", () => ({ ...nativeOs, homedir: () => home }));
mock.module("os", () => ({ ...nativeOs, homedir: () => home }));
mock.module("node:fs", () => ({ ...fs, promises, default: { ...fs, promises } }));
mock.module("fs", () => ({ ...fs, promises, default: { ...fs, promises } }));
mock.module("node:fs/promises", () => ({ ...promises, default: promises }));
mock.module("fs/promises", () => ({ ...promises, default: promises }));
const lexicalRoots = [".ravi", ".codex", ".ssh", ".omni", ".aws", ".config", ".npmrc"].map((name) => join(home, name));
process.env.PR795_PROTECTED_ROOTS = JSON.stringify({
  version: 1,
  lexicalRoots,
  canonicalRoots: lexicalRoots.map((root) => (root === privateRoot ? resolvedPrivateRoot : root)),
});
const dns = process.env.RETAINED_GUARD_SCENARIO?.startsWith("dns-")
  ? await installRetainedDnsSentinels()
  : { calls: [], originalSurfaces: [] };
export const probe = { calls, dns, privateRoot, resolvedPrivateRoot, outside, state };
Object.assign(globalThis, { __retainedContractProbe: probe });
await import("./retained-memory-preload.js");
