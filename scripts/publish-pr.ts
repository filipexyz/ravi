import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getContext } from "../src/cli/context.js";
import { publishGhPr } from "../src/hooks/gh-pr-publish.js";
import { nats } from "../src/nats.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    repo: { type: "string" }, base: { type: "string", default: "dev" },
    title: { type: "string" }, "body-file": { type: "string" }, help: { type: "boolean" },
  },
});
if (values.help) {
  console.log("bun scripts/publish-pr.ts --repo owner/repo --base dev --title <title> --body-file <path>");
  console.log("Run in the publishing Ravi session, after uploading the current commit via Git Data API.");
  console.log("Creates a ready PR, or reconciles that branch's existing PR and its CI follow. No git push or hook bypass.");
  process.exit(0);
}

try {
  if (!values.repo || !values.title || !values["body-file"]) throw new Error("Required: --repo, --title, --body-file");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", timeout: 10_000 }).trim();
  const head = git("symbolic-ref", "--short", "HEAD");
  if (git("status", "--porcelain")) throw new Error("Commit the working tree before publishing");
  const context = getContext();
  if (!context) throw new Error("Run from the publishing Ravi session");
  const result = await publishGhPr({
    repo: values.repo, base: values.base!, head, sha: git("rev-parse", "HEAD"),
    title: values.title, body: readFileSync(values["body-file"], "utf8"),
    context: { agentId: context.agentId, sessionName: context.sessionName, sessionKey: context.sessionKey,
      source: context.source, accountId: context.source?.accountId },
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "PR publication failed");
  process.exitCode = 1;
} finally {
  await nats.close();
}
