import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { Client, utils } from "ssh2";
import { FleetError, type Installation, type ProbeResult } from "./contract";

export function privateSshAddress(address: string) {
  if (!isIPv4(address)) return false;
  // Provider metadata endpoint inside CGNAT; never a fleet SSH target.
  if (address === "100.100.100.200") return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
}
export function validatePrivateKey(value: string) {
  const key = utils.parseKey(value);
  if (key instanceof Error || Array.isArray(key) || !key.isPrivateKey()) throw new FleetError("invalid_ssh_key");
}
export function matchesHostKey(rawKey: Buffer, expected: string) {
  return `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}` === expected;
}
export function parseCliVersion(output: string) {
  // Only a version is returned. Banners, shell output and errors are never UI data.
  const match = /^(?:ravi(?:\.bot)?\s+)?v?(\d{1,4}\.\d{1,8}\.\d{1,8}(?:-[A-Za-z0-9.-]{1,40})?)\s*$/.exec(output.trim());
  return match?.[1] ?? null;
}

export async function probeInstallation(installation: Installation, privateKey: string): Promise<ProbeResult> {
  let addresses; let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([lookup(installation.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error()), 3000); dnsTimer.unref(); })]);
  } catch { return { ok: false, code: "host_unreachable" }; }
  finally { clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some(a => !privateSshAddress(a.address))) return { ok: false, code: "target_not_allowed" };
  try { validatePrivateKey(privateKey); } catch { return { ok: false, code: "invalid_ssh_key" }; }
  return sshVersionProbe(installation, privateKey, addresses[0]!.address);
}

/** Internal transport primitive. HTTP callers MUST use probeInstallation so
 * resolution and address policy run first. Exported for loopback protocol tests. */
export function sshVersionProbe(installation: Installation, privateKey: string, resolvedAddress: string): Promise<ProbeResult> {
  return new Promise(resolve => {
    const client = new Client(); let finished = false; let hostMismatch = false;
    const done = (result: ProbeResult) => { if (finished) return; finished = true; clearTimeout(timer); client.destroy(); resolve(result); };
    const timer = setTimeout(() => done({ ok: false, code: "probe_timeout" }), 12_000);
    client.on("error", () => done({ ok: false, code: hostMismatch ? "host_key_mismatch" : "ssh_authentication_failed" }));
    client.on("close", () => done({ ok: false, code: "ssh_connection_closed" }));
    client.on("ready", () => {
      client.exec("ravi --version", { pty: false }, (error, stream) => {
        if (error) return done({ ok: false, code: "ravi_cli_unavailable" });
        let output = ""; let bytes = 0;
        stream.on("data", (data: Buffer) => {
          bytes += data.byteLength;
          if (bytes > 4096) return done({ ok: false, code: "ravi_cli_unavailable" });
          output += data.toString("utf8");
        });
        stream.stderr.on("data", (data: Buffer) => {
          bytes += data.byteLength;
          if (bytes > 4096) done({ ok: false, code: "ravi_cli_unavailable" });
        });
        stream.on("close", (code: number) => {
          const cliVersion = parseCliVersion(output);
          done(code === 0 && cliVersion ? { ok: true, cliVersion } : { ok: false, code: "ravi_cli_unavailable" });
        });
      });
    });
    try { client.connect({ host: resolvedAddress, port: installation.port, username: installation.username,
      privateKey, readyTimeout: 8000, agentForward: false, tryKeyboard: false,
      hostVerifier: (rawKey: Buffer) => { const match = matchesHostKey(rawKey, installation.hostFingerprint); hostMismatch = !match; return match; },
    }); } catch { done({ ok: false, code: "ssh_authentication_failed" }); }
  });
}
