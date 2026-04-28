/**
 * Public entry point for the `@ravi-os/sdk` codegen.
 *
 * Consumers (CLI command, tests) import from here. The internal modules
 * (`emit-files.ts`, `naming.ts`, `registry-shape.ts`) are deliberately not
 * exposed so the public surface can evolve without churning callers.
 */

export {
  emitAll,
  emitTypes,
  emitSchemas,
  emitClient,
  emitVersion,
  type EmittedSdk,
  type EmitOptions,
  type EmitVersionInput,
} from "./emit-files.js";
export { computeRegistryHash } from "./registry-hash.js";
