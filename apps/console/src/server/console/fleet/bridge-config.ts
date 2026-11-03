import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { FleetError } from "./contract";

export const bridgeBindingSchema=z.object({
  organizationId:z.string().uuid(),installationId:z.string().uuid(),installationRevision:z.number().int().positive(),
  credentialRevision:z.number().int().positive(),enrollmentId:z.string().uuid(),runtimeId:z.string().uuid(),
  runtimePublicKey:z.string().min(50).max(2000),issuer:z.string().url(),issuerKeyId:z.string().min(1).max(100),
  signingKeyRef:z.object({credentialId:z.string().uuid(),version:z.number().int().positive()}).strict(),
  epoch:z.number().int().positive(),active:z.boolean(),
}).strict();
export type BridgeBinding=z.infer<typeof bridgeBindingSchema>;
/** Operator-owned public bindings; private signer material is only in the existing Vault adapter. */
export async function bridgeBindings():Promise<BridgeBinding[]> {
  const path=process.env.RAVI_BRIDGE_BINDINGS_FILE;
  if(!path) return [];
  if(!path.startsWith("/")) throw new FleetError("bridge_not_configured",503);
  let file;
  try {
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await file.stat();
    if(!stat.isFile() || (stat.mode & 0o022)!==0 || stat.size>262_144) throw new Error();
    if(typeof process.getuid==="function" && ![0,process.getuid()].includes(stat.uid)) throw new Error();
    const bindings=z.array(bridgeBindingSchema).max(100).parse(JSON.parse(await file.readFile("utf8")));
    if(new Set(bindings.map(b=>b.organizationId+":"+b.installationId)).size!==bindings.length) throw new Error();
    return bindings;
  } catch {throw new FleetError("bridge_not_configured",503);}
  finally {await file?.close();}
}
