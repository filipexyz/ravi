import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TUI_ENTRYPOINTS = ["src/tui/index.tsx", "dist/tui/index.js"] as const;

export function resolveTuiEntrypoint(projectRoot: string): string {
  for (const relativePath of TUI_ENTRYPOINTS) {
    const candidate = join(projectRoot, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      "TUI entrypoint not found.",
      `Looked for: ${TUI_ENTRYPOINTS.map((relativePath) => join(projectRoot, relativePath)).join(", ")}`,
      "Run `bun run build` or reinstall ravi.bot from a package that includes dist/tui/.",
    ].join(" "),
  );
}

export async function spawnDirectTui(session: string, projectRoot: string): Promise<void> {
  const tuiPath = resolveTuiEntrypoint(projectRoot);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", [tuiPath, session], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if ((code ?? 0) !== 0) {
        reject(new Error(`TUI exited with code ${code ?? 0}`));
        return;
      }
      resolve();
    });
  });
}
