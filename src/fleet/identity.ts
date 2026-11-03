import "reflect-metadata";
import { mkdir, readFile, rename, stat, open } from "node:fs/promises";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { Pkcs10CertificateRequestGenerator } from "@peculiar/x509";
import { z } from "zod";
import { getRaviStateDir } from "../utils/paths.js";

const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.hash && !url.search
    );
  });
export const fleetIdentitySchema = z
  .object({
    consoleUrl: origin,
    transportUrl: origin,
    installationId: z.string().uuid(),
    organizationId: z.string().uuid(),
    privateKey: z.string(),
    certificate: z.string(),
    ca: z.string(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type FleetIdentity = z.infer<typeof fleetIdentitySchema>;
export const fleetDirectory = () => join(getRaviStateDir(), "fleet");

export async function writePrivateJson(name: string, value: unknown, directory = fleetDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if ((info.mode & 0o077) !== 0) throw new Error("Fleet state directory must have mode 0700");
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, name));
  const folder = await open(directory, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
export async function readPrivateJson(name: string, directory = fleetDirectory()): Promise<unknown | null> {
  const path = join(directory, name);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new Error("Invalid Fleet state permissions");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function readFleetIdentity(directory = fleetDirectory()) {
  const value = await readPrivateJson("identity.json", directory);
  return value ? fleetIdentitySchema.parse(value) : null;
}
export async function generateNodeKey() {
  const provider = webcrypto as unknown as Crypto;
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await provider.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  const csr = await Pkcs10CertificateRequestGenerator.create(
    { name: "CN=Ravi installation", keys, signingAlgorithm: algorithm },
    provider,
  );
  const der = Buffer.from(await provider.subtle.exportKey("pkcs8", keys.privateKey));
  return {
    privateKey: `-----BEGIN PRIVATE KEY-----\n${der
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END PRIVATE KEY-----\n`,
    csr: csr.toString("pem"),
  };
}
const pendingSchema = z
  .object({
    consoleUrl: origin,
    name: z.string(),
    platform: z.string(),
    privateKey: z.string(),
    csr: z.string(),
    challenge: z.string(),
  })
  .strict();
export async function prepareAssociation(consoleUrl: string, name = hostname(), directory = fleetDirectory()) {
  const normalized = origin.parse(consoleUrl);
  const existing = await readFleetIdentity(directory);
  if (existing)
    throw new Error("This installation is already associated; disconnect it before choosing another Console");
  const saved = await readPrivateJson("association.json", directory);
  if (saved) {
    const pending = pendingSchema.parse(saved);
    if (pending.consoleUrl !== normalized) throw new Error("A different Console association is pending");
    return pending;
  }
  const pending = {
    consoleUrl: normalized,
    name,
    platform: `${process.platform}-${process.arch}`,
    ...(await generateNodeKey()),
    challenge: randomBytes(32).toString("hex"),
  };
  await writePrivateJson("association.json", pending, directory);
  return pending;
}
