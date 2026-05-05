/**
 * Public entry point for Swift SDK codegen.
 */

export {
  emitAllSwift,
  emitSwiftClient,
  emitSwiftTypes,
  emitSwiftSchemas,
  emitSwiftVersion,
  compareSwiftSdkSource,
  type EmittedSwiftSdk,
  type EmitSwiftOptions,
  type EmitSwiftVersionInput,
  type GeneratedSwiftSdkFile,
  type SwiftSdkSourceComparison,
} from "./emit-files.js";
export { computeRegistryHash } from "../client-codegen/registry-hash.js";
