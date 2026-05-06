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
  compareSdkSource,
  type EmittedSdk,
  type EmitOptions,
  type EmitVersionInput,
  type GeneratedSdkFile,
  type SdkSourceComparison,
} from "./emit-files.js";
export { computeRegistryHash } from "./registry-hash.js";
