import { runtimeOperationSchema } from "./console.ts";
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function commandDigest(installationId: string, operationId: string, command: unknown) {
  return sha256(JSON.stringify(["ravi-fleet/1", installationId, operationId, runtimeOperationSchema.parse(command)]));
}
