/**
 * Inert originals for the retained preload's DNS regression tests.
 * Install before importing the candidate preload, in a disposable process with
 * an independent network-denying sandbox. Namespace adaptation retains the
 * actual default and nested promises objects; it never invents DNS identities.
 */
import { mock } from "bun:test";
import { createRequire } from "node:module";

export const RETAINED_DNS_OPERATIONS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "reverse",
] as const;
export const RETAINED_DNS_SENTINEL_CODE = "RETAINED_DNS_ORIGINAL_SENTINEL";

type DnsOperation = (typeof RETAINED_DNS_OPERATIONS)[number];
type DnsModule = Record<string, unknown>;

export interface RetainedDnsSentinelCall {
  operation: DnsOperation;
}

export interface RetainedDnsSurface {
  name: string;
  kind: "callback" | "promise";
  module: DnsModule;
}

interface DnsTarget {
  module: DnsModule;
  names: string[];
  mutableFirst: boolean;
}

interface DnsImport {
  specifier: string;
  module: DnsModule;
}

function isModule(value: unknown): value is DnsModule {
  return typeof value === "object" && value !== null;
}

/** Reads fixed builtin aliases only; it never invokes a DNS export. */
async function collectDnsSurfaces(): Promise<{
  surfaces: RetainedDnsSurface[];
  targets: DnsTarget[];
  imports: DnsImport[];
}> {
  const specifiers = ["node:dns", "dns", "node:dns/promises", "dns/promises"] as const;
  const imported = await Promise.all(specifiers.map((specifier) => import(specifier)));
  const requireBuiltin = createRequire(import.meta.url);
  const surfaces: RetainedDnsSurface[] = [];
  const targets = new Map<DnsModule, DnsTarget>();

  function add(name: string, value: unknown, kind: RetainedDnsSurface["kind"], mutableFirst: boolean): DnsModule {
    if (!isModule(value)) throw new Error(`RETAINED_DNS_SENTINEL_SETUP_FAILED: missing builtin ${name}`);
    surfaces.push({ name, kind, module: value });
    const existing = targets.get(value);
    if (existing) {
      existing.names.push(name);
      existing.mutableFirst ||= mutableFirst;
    } else {
      targets.set(value, { module: value, names: [name], mutableFirst });
    }
    return value;
  }

  function addPromises(name: string, value: unknown): void {
    const promises = add(name, value, "promise", true);
    if (isModule(promises.default)) add(`${name}.default`, promises.default, "promise", true);
  }

  function addExports(name: string, value: unknown, kind: RetainedDnsSurface["kind"], mutableFirst: boolean): void {
    const module = add(name, value, kind, mutableFirst);
    if (kind === "callback") addPromises(`${name}.promises`, module.promises);
    if (isModule(module.default)) {
      const defaultModule = add(`${name}.default`, module.default, kind, true);
      if (kind === "callback") addPromises(`${name}.default.promises`, defaultModule.promises);
    }
  }

  for (const [index, specifier] of specifiers.entries()) {
    const kind = specifier.endsWith("/promises") ? "promise" : "callback";
    addExports(`import:${specifier}`, imported[index], kind, false);
    addExports(`require:${specifier}`, requireBuiltin(specifier), kind, true);
  }

  // Patch actual default/CJS/nested objects before namespace bindings that may
  // reflect those objects. Preserve duplicate surface names for test coverage.
  return {
    surfaces,
    targets: [...targets.values()].sort((left, right) => Number(right.mutableFirst) - Number(left.mutableFirst)),
    imports: specifiers.map((specifier, index) => ({ specifier, module: imported[index] })),
  };
}

/** Capture fresh post-preload namespaces/defaults, including standalone promises. */
export async function readRetainedDnsSurfaces(): Promise<RetainedDnsSurface[]> {
  return (await collectDnsSurfaces()).surfaces;
}

export interface RetainedDnsSentinels {
  calls: RetainedDnsSentinelCall[];
  originalSurfaces: readonly RetainedDnsSurface[];
  namespaceFallbacks: readonly string[];
}

/**
 * Replaces callable properties of the actual builtin objects in place. Every
 * replacement records its operation and throws synchronously, including promise
 * APIs. Original functions are never called, saved for forwarding, or restored.
 */
export async function installRetainedDnsSentinels(): Promise<RetainedDnsSentinels> {
  const { surfaces, targets, imports } = await collectDnsSurfaces();
  const calls: RetainedDnsSentinelCall[] = [];
  const sentinels = new Map<DnsOperation, () => never>();

  for (const operation of RETAINED_DNS_OPERATIONS) {
    sentinels.set(operation, () => {
      calls.push({ operation });
      throw new Error(`${RETAINED_DNS_SENTINEL_CODE}: ${operation}`);
    });
  }

  // Validate all expected APIs before changing any export. An absent surface is
  // a setup failure, never a skipped test or a reason to invoke an original.
  for (const target of targets) {
    for (const operation of RETAINED_DNS_OPERATIONS) {
      if (typeof target.module[operation] !== "function" || !Object.hasOwn(target.module, operation)) {
        throw new Error(`RETAINED_DNS_SENTINEL_SETUP_FAILED: missing ${target.names[0]}.${operation}`);
      }
    }
  }

  for (const target of targets) {
    for (const operation of RETAINED_DNS_OPERATIONS) {
      const sentinel = sentinels.get(operation)!;
      if (target.module[operation] === sentinel) continue;
      const descriptor = Object.getOwnPropertyDescriptor(target.module, operation)!;
      if ("value" in descriptor) {
        // Bun exports can be non-configurable but writable. Supplying only value
        // preserves every existing flag and works for that descriptor shape.
        Reflect.defineProperty(target.module, operation, { value: sentinel });
      } else if (descriptor.configurable) {
        // Convert configurable accessors without changing configurable/enumerable.
        Reflect.defineProperty(target.module, operation, { value: sentinel, writable: true });
      }
    }
  }

  // Bun lacks Node's syncBuiltinESMExports. Its immutable namespace bindings may
  // retain native functions even after their actual default objects are patched.
  // Prepare all adapters before registering any of them, preserving the exact
  // builtin default and nested promises references in the shallow export copy.
  const namespaceReplacements = new Map<DnsModule, DnsModule>();
  const namespaceAdapters = imports
    .filter(({ module }) => RETAINED_DNS_OPERATIONS.some((operation) => module[operation] !== sentinels.get(operation)))
    .map(({ specifier, module }) => {
      let replacement = namespaceReplacements.get(module);
      if (!replacement) {
        replacement = { ...module };
        for (const operation of RETAINED_DNS_OPERATIONS) replacement[operation] = sentinels.get(operation)!;
        namespaceReplacements.set(module, replacement);
      }
      return { specifier, replacement };
    });
  for (const { specifier, replacement } of namespaceAdapters) mock.module(specifier, () => replacement);

  // Bun documents live-binding updates for an already imported mock.module.
  // Materialize the factories through fresh imports first, then verify all old
  // and fresh routes without calling any export. A native callable is fatal.
  const freshSurfaces = await readRetainedDnsSurfaces();
  for (const target of targets) {
    for (const operation of RETAINED_DNS_OPERATIONS) {
      if (target.module[operation] !== sentinels.get(operation)) {
        throw new Error(`RETAINED_DNS_SENTINEL_SETUP_FAILED: immutable ${target.names[0]}.${operation}`);
      }
    }
  }

  for (const surface of freshSurfaces) {
    for (const operation of RETAINED_DNS_OPERATIONS) {
      if (surface.module[operation] !== sentinels.get(operation)) {
        throw new Error(`RETAINED_DNS_SENTINEL_SETUP_FAILED: native fresh ${surface.name}.${operation}`);
      }
    }
  }
  for (const surface of surfaces) {
    if (!surface.name.includes(".default") && !surface.name.includes(".promises")) continue;
    const fresh = freshSurfaces.find((candidate) => candidate.name === surface.name);
    if (fresh?.module !== surface.module) {
      throw new Error(`RETAINED_DNS_SENTINEL_SETUP_FAILED: changed builtin identity ${surface.name}`);
    }
  }

  return { calls, originalSurfaces: surfaces, namespaceFallbacks: namespaceAdapters.map(({ specifier }) => specifier) };
}
