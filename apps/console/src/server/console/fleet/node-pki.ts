import "reflect-metadata";
import { readFile, stat } from "node:fs/promises";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import {
  Pkcs10CertificateRequest, X509Certificate, X509CertificateGenerator,
  BasicConstraintsExtension, ExtendedKeyUsageExtension, ExtendedKeyUsage,
  KeyUsagesExtension, KeyUsageFlags,
} from "@peculiar/x509";
import { FleetError } from "./contract";

const cryptoProvider = webcrypto as unknown as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
export const certificateFingerprint = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

export async function protectedFile(path: string | undefined) {
  if (!path) throw new FleetError("fleet_identity_not_configured", 503);
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new FleetError("fleet_identity_file_permissions", 503);
  }
  return readFile(path, "utf8");
}

/** Caller-controlled CSR extensions/subject are never copied into a certificate. */
export async function verifiedRequest(pem: string) {
  try {
    const csr = new Pkcs10CertificateRequest(pem);
    const key = await csr.publicKey.export(cryptoProvider);
    if (key.algorithm.name !== "ECDSA" || (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" || !await csr.verify(cryptoProvider)) {
      throw new Error("invalid request");
    }
    return { csr, fingerprint: Buffer.from(await csr.publicKey.getThumbprint("SHA-256", cryptoProvider)).toString("hex") };
  } catch { throw new FleetError("invalid_certificate_request", 400); }
}

export interface NodeCertificateIssuer {
  issue(csr: string, installationId: string): Promise<{ certificate: string; fingerprint: string; expiresAt: Date }>;
  ca(): Promise<string>;
}

export class FileNodeCertificateIssuer implements NodeCertificateIssuer {
  async ca() { return protectedFile(process.env.RAVI_FLEET_CA_CERT_FILE); }
  async issue(pem: string, installationId: string) {
    if (!/^[a-f0-9-]{36}$/.test(installationId)) throw new FleetError("invalid_request", 400);
    const { csr } = await verifiedRequest(pem);
    const [caPem, keyPem] = await Promise.all([this.ca(), protectedFile(process.env.RAVI_FLEET_CA_KEY_FILE)]);
    const ca = new X509Certificate(caPem);
    const rawKey = Buffer.from(keyPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const signingKey = await cryptoProvider.subtle.importKey("pkcs8", rawKey, algorithm, false, ["sign"]);
    const now = Date.now();
    const expiresAt = new Date(Math.min(now + 24 * 60 * 60 * 1000, ca.notAfter.getTime()));
    if (ca.notBefore.getTime() > now || expiresAt.getTime() <= now + 60_000) throw new FleetError("fleet_ca_expired", 503);
    const certificate = await X509CertificateGenerator.create({
      subject: `CN=${installationId}`, issuer: ca.subject, publicKey: csr.publicKey,
      signingKey, signingAlgorithm: algorithm, serialNumber: randomBytes(16).toString("hex"),
      notBefore: new Date(now - 30_000), notAfter: expiresAt,
      extensions: [new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth], true)],
    }, cryptoProvider);
    if (!await certificate.verify({ publicKey: ca.publicKey }, cryptoProvider)) throw new FleetError("fleet_ca_key_mismatch", 503);
    return { certificate: certificate.toString("pem"), expiresAt,
      fingerprint: certificateFingerprint(new Uint8Array(certificate.rawData)) };
  }
}
