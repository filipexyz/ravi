import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

type AccountLookup = (
  command: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    stdio: ["ignore", "pipe", "ignore"];
    env: Record<string, string>;
  },
) => { status: number | null; stdout: string; error?: Error };

/** Bun's userInfo().homedir can inherit HOME; query the account database by UID. */
export function resolveAccountHome(
  options: { platform?: NodeJS.Platform; uid?: number; lookup?: AccountLookup } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) return null;
  const command = platform === "darwin" ? "/usr/bin/dscacheutil" : platform === "linux" ? "/usr/bin/getent" : null;
  if (!command) return null;
  const args = platform === "darwin" ? ["-q", "user", "-a", "uid", String(uid)] : ["passwd", String(uid)];
  const lookup: AccountLookup = options.lookup ?? spawnSync;
  try {
    const result = lookup(command, args, {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16_384,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    if (result.error || result.status !== 0) return null;
    const records = result.stdout.trimEnd().split(platform === "darwin" ? /\n\s*\n/ : /\n/);
    if (records.length !== 1) return null;
    const record = records[0]!;
    const fields = record.split(":");
    const accountUid = platform === "darwin" ? /^uid: (\d+)$/m.exec(record)?.[1] : fields[2];
    const home = platform === "darwin" ? /^dir: (.+)$/m.exec(record)?.[1] : fields[5];
    if (accountUid !== String(uid) || !home || !isAbsolute(home) || /[\r\n\0]/.test(home)) return null;
    return home;
  } catch {
    // no-cause: Missing or invalid OS account evidence disables implicit real-state transport.
    return null;
  }
}
