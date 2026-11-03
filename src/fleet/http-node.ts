/** Native Node TLS boundary. Credentials arrive only through this process's stdin. */
import { request } from "node:https";
import { rootCertificates } from "node:tls";

let headersSent = false;
function unavailable() {
  if (!headersSent)
    process.stdout.write(
      `${JSON.stringify({ status: 503, headers: { "content-type": "application/json" } })}\n{"error":{"code":"transport_unavailable"}}`,
    );
  process.exitCode = 1;
}
try {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 131072) throw new Error("Request too large");
    parts.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
  const url = new URL(input.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !["/commands", "/receipts", "/rotate"].includes(url.pathname)
  )
    throw new Error("Invalid destination");
  const data = input.body === undefined ? undefined : JSON.stringify(input.body);
  const req = request(
    url,
    {
      method: data === undefined ? "GET" : "POST",
      key: input.key,
      cert: input.cert,
      ca: [...rootCertificates, input.ca],
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      agent: false,
      headers:
        data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    },
    (response) => {
      headersSent = true;
      process.stdout.write(
        `${JSON.stringify({ status: response.statusCode, headers: { "content-type": response.headers["content-type"] ?? "application/octet-stream" } })}\n`,
      );
      response.pipe(process.stdout);
      response.on("error", () => {
        req.destroy();
        process.exitCode = 1;
      });
    },
  );
  req.on("error", unavailable);
  req.setTimeout(20000, () => req.destroy(new Error("Transport timed out")));
  process.once("SIGTERM", () => {
    req.destroy();
    process.exit(0);
  });
  process.stdout.once("error", () => {
    req.destroy();
    process.exit(0);
  });
  req.end(data);
} catch {
  unavailable();
}
