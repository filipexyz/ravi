import "reflect-metadata";
import { mkdir, open, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, webcrypto } from "node:crypto";
import { X509CertificateGenerator, BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags, ExtendedKeyUsageExtension, ExtendedKeyUsage, SubjectAlternativeNameExtension } from "@peculiar/x509";

const provider = webcrypto as unknown as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
async function key() { return provider.subtle.generateKey(algorithm, true, ["sign", "verify"]) as Promise<CryptoKeyPair>; }
async function pem(key: CryptoKey) { return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await provider.subtle.exportKey("pkcs8", key)).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`; }
/** Creates a dedicated node-only authority; never trusts the executor's own CA. */
export async function createNodeAuthority(hostname: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(hostname)) throw new Error("Invalid transport hostname");
  const caKeys = await key(), serverKeys = await key(), now = Date.now();
  const ca = await X509CertificateGenerator.createSelfSigned({ name: "CN=Ravi installation authority", keys: caKeys,
    serialNumber: randomBytes(16).toString("hex"), signingAlgorithm: algorithm,
    notBefore: new Date(now - 30_000), notAfter: new Date(now + 365 * 86400_000),
    extensions: [new BasicConstraintsExtension(true, 0, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)],
  }, provider);
  const certificate = await X509CertificateGenerator.create({ subject: `CN=${hostname}`, issuer: ca.subject,
    publicKey: serverKeys.publicKey, signingKey: caKeys.privateKey, signingAlgorithm: algorithm,
    serialNumber: randomBytes(16).toString("hex"), notBefore: new Date(now - 30_000), notAfter: ca.notAfter,
    extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
      new SubjectAlternativeNameExtension([{ type: /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ? "ip" : "dns", value: hostname }])],
  }, provider);
  return { ca: ca.toString("pem"), caKey: await pem(caKeys.privateKey), certificate: certificate.toString("pem"), key: await pem(serverKeys.privateKey) };
}
export async function initializeNodeAuthority(directory: string, hostname: string) {
  // Exclusive writes refuse replacement of an existing trust root.
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const lock = await open(join(directory, "authority.initializing"), "wx", 0o600);
  try {
    const material = await createNodeAuthority(hostname);
    for (const [name, value] of Object.entries({ "ca.pem": material.ca, "ca-key.pem": material.caKey, "server.pem": material.certificate, "server-key.pem": material.key })) {
      const file = await open(join(directory, name), "wx", 0o600);
      try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    }
  } finally { await lock.close(); }
}
