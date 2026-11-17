/** Pure synthetic bootstrap checks: no private filesystem metadata is consulted. */
import { expect } from "bun:test";
import {
  captureRetainedProtectedRoots,
  parseRetainedProtectedRoots,
  retainedMacProfile,
  retainedProtectedRootUnion,
} from "./retained-preload-policy.js";

/** Exercises child symlinks, home aliases, missing children and fail-closed resolution/decoding. */
export function verifyRetainedRootPolicy(): void {
  const reads: string[] = [];
  const roots = captureRetainedProtectedRoots("/virtual/home", (path) => {
    reads.push(path);
    if (path === "/virtual/home/.ssh") return "/virtual/private-ssh";
    if (path === "/virtual/home/.config") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return path.replace("/virtual/home", "/virtual/actual-home");
  });
  expect(roots.lexicalRoots).toContain("/virtual/home/.ssh");
  expect(roots.canonicalRoots).toContain("/virtual/private-ssh");
  expect(roots.canonicalRoots).toContain("/virtual/actual-home/.config");
  expect(reads).toContain("/virtual/home");
  const union = retainedProtectedRootUnion(roots);
  expect(union).toContain("/virtual/home/.config");
  for (const root of union) expect(retainedMacProfile(roots)).toContain(`(subpath ${JSON.stringify(root)})`);
  expect(parseRetainedProtectedRoots(JSON.stringify(roots))).toEqual(roots);
  expect(() => captureRetainedProtectedRoots("relative", () => "unused")).toThrow("absolute");
  expect(() =>
    captureRetainedProtectedRoots("/virtual/home", () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }),
  ).toThrow("permission denied");
  expect(() => parseRetainedProtectedRoots(undefined)).toThrow("Missing");
  expect(() => parseRetainedProtectedRoots("{}")).toThrow("Invalid");
  expect(() => parseRetainedProtectedRoots(JSON.stringify({ ...roots, canonicalRoots: ["relative"] }))).toThrow(
    "Invalid",
  );
  expect(() => parseRetainedProtectedRoots(JSON.stringify({ ...roots, version: 2 }))).toThrow("Invalid");
}
