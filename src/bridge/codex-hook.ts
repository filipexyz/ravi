// Standalone provider hook: any CLI failure or malformed response is a denial.
// No runtime/env initialization here: use only this turn's inherited authority.
import { spawn, stdin } from "bun";
const deny = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Bridge tool authorization is unavailable",
  },
};
try {
  const input = await stdin.text();
  if (Buffer.byteLength(input) > 65_536) throw new Error("Oversized hook input");
  const child = spawn(
    [
      process.execPath,
      new URL("./index.js", import.meta.url).pathname,
      "context",
      "bridge-tool-hook",
      "--json",
      "--payload",
      input,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    },
  );
  const timer = setTimeout(() => child.kill(), 590_000);
  try {
    const text = await new Response(child.stdout).text();
    const status = await child.exited;
    const result = JSON.parse(text);
    if (status !== 0)
      console.error(
        `Bridge hook refused: exit ${status}; code ${typeof result?.error?.code === "string" ? result.error.code : "unknown"}`,
      );
    const emptyAllow =
      result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).length === 0;
    const explicitDeny =
      result?.hookSpecificOutput?.hookEventName === "PreToolUse" &&
      result?.hookSpecificOutput?.permissionDecision === "deny";
    console.log(JSON.stringify(status === 0 && (emptyAllow || explicitDeny) ? result : deny));
  } finally {
    clearTimeout(timer);
  }
} catch {
  console.error("Bridge hook response could not be validated");
  console.log(JSON.stringify(deny));
}
