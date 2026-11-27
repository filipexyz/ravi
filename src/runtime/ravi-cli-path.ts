import { dirname, join } from "node:path";

/** Host-owned launcher configuration; never resolve it from a tool command or turn env. */
export function resolveCanonicalRaviCliPath(): string | null {
  const explicit = process.env.RAVI_BIN?.trim();
  if (explicit) {
    return explicit;
  }

  const bundlePath = process.argv[1];
  if (!bundlePath) {
    return null;
  }

  return join(dirname(dirname(dirname(bundlePath))), "bin", "ravi");
}
