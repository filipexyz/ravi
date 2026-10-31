import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalBridgeJson } from "./protocol.js";

export const enrollmentSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    installationId: z.string().uuid(),
    runtimeId: z.string().uuid(),
    issuer: z.string().min(1).max(200),
    issuerPublicKey: z.string().max(2000),
    issuerKeyId: z.string().min(1).max(100),
    epoch: z.number().int().positive(),
    active: z.boolean(),
  })
  .strict();
export function requestDigest(request: unknown) {
  return createHash("sha256").update(canonicalBridgeJson(request)).digest("hex");
}
export function runtimeIdentity(dir: string) {
  const path = join(dir, "identity.json");
  if (existsSync(path))
    return JSON.parse(readFileSync(path, "utf8")) as { runtimeId: string; publicKey: string; privateKey: string };
  const pair = generateKeyPairSync("ed25519");
  const identity = {
    runtimeId: randomUUID(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  writeFileSync(path, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
  return identity;
}
