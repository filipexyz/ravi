/**
 * Type-level tests for `@ravi-os/sdk`.
 *
 * Bun runs `*.test-d.ts` like any other test file; we use compile-time `Expect`
 * assertions to pin the public type surface. Anything that breaks the typed
 * contract (parameter shape, return type, options bag) fails to compile.
 */

import { describe, expect, it } from "bun:test";
import type { RaviClient } from "../client.js";
import type {
  ArtifactsShowReturn,
  ContextCredentialsListReturn,
} from "../types.js";

type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type ExpectTrue<T extends true> = T;
type ExpectFalse<T extends false> = T;

declare const client: RaviClient;

// `client.artifacts.show(id)` — single positional string, return Promise<ArtifactsShowReturn>.
type ArtifactsShowFn = typeof client.artifacts.show;
type ArtifactsShowParams = Parameters<ArtifactsShowFn>;
type ArtifactsShowResult = Awaited<ReturnType<ArtifactsShowFn>>;

type _ShowParamsOk = ExpectTrue<Eq<ArtifactsShowParams, [id: string]>>;
type _ShowReturnOk = ExpectTrue<Eq<ArtifactsShowResult, ArtifactsShowReturn>>;

// `client.context.credentials.list()` — no required args; return is `unknown`
// because the underlying command does not declare `@Returns`.
type ListFn = typeof client.context.credentials.list;
type ListParams = Parameters<ListFn>;
type ListResult = Awaited<ReturnType<ListFn>>;

type _ListReturnOk = ExpectTrue<Eq<ListResult, ContextCredentialsListReturn>>;
type _ListReturnIsUnknown = ExpectTrue<Eq<ContextCredentialsListReturn, unknown>>;
type _ListParamsOk = ExpectFalse<Eq<ListParams, [string]>>;

describe("types.test-d", () => {
  it("compiles the typed surface", () => {
    // The Expect* aliases above run at compile time — this test only ensures
    // the file is loaded by bun (no runtime assertions needed).
    expect(true).toBe(true);
  });
});

// Mark unused type aliases as referenced so `noUnusedLocals` doesn't bark.
// The aliases assert at compile time; the runtime body just touches the names.
const _typeRef: { kind: "type-only" } = { kind: "type-only" };
void _typeRef;
type _Touched =
  | _ShowParamsOk
  | _ShowReturnOk
  | _ListReturnOk
  | _ListReturnIsUnknown
  | _ListParamsOk;
export type { _Touched };
