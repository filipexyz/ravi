/**
 * Public entry point for Dart SDK codegen.
 */

export {
  emitAllDart,
  emitDartClient,
  emitDartTypes,
  emitDartSchemas,
  emitDartVersion,
  compareDartSdkSource,
  type EmittedDartSdk,
  type EmitDartOptions,
  type EmitDartVersionInput,
  type GeneratedDartSdkFile,
  type DartSdkSourceComparison,
} from "./emit-files.js";
export { computeRegistryHash } from "../client-codegen/registry-hash.js";
