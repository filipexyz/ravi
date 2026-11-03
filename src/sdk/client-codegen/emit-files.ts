/** Runtime projection: compose neutral codegen with the runtime stream catalog. */
import type { RegistrySnapshot } from "../../cli/registry-snapshot.js";
import { defaultStreamChannels } from "../gateway/streaming/channels.js";
import { emitAll as emitOperations, type EmitOptions } from "@ravi/sdk-codegen/emit-files";
export * from "@ravi/sdk-codegen/emit-files";
export function emitAll(registry: RegistrySnapshot, options: EmitOptions) {
  return emitOperations(registry, { ...options, streams: defaultStreamChannels });
}
