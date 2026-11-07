import { createHash } from "node:crypto";
import { LIMITS, prError, SHA } from "./contracts.js";
import { commitSchema, oidSchema, optionalRequest, parseGithub, type GithubRequest } from "./github.js";
import { runProcess } from "./process.js";

export interface GitObject {
  sha: string;
  type: "blob" | "tree" | "commit";
  bytes: number;
  payload: Record<string, unknown>;
}
export interface GitSnapshot {
  head: string;
  sha: string;
  tree: string;
}
export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  path: string;
}
export const gitHash = (type: string, bytes: Buffer) =>
  createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
export function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw prError("GIT_FORMAT_UNSUPPORTED", "Git object contains text not representable as UTF-8.");
  }
}

export class LocalGit {
  readonly env: NodeJS.ProcessEnv;
  constructor(
    readonly cwd: string,
    readonly signal?: AbortSignal,
  ) {
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(this.env, { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
  }
  async run(args: string[], allowFailure = false) {
    const result = await runProcess(
      "git",
      ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", this.cwd, ...args],
      { env: this.env, signal: this.signal },
    );
    if (result.code && !allowFailure)
      throw prError(
        "LOCAL_GIT_INVALID",
        "Cannot read the requested worktree or Git object. Check branch, local history and origin.",
      );
    return result;
  }
  async text(args: string[]): Promise<string> {
    return (await this.run(args)).stdout.toString("utf8").trim();
  }
  async object(type: string, sha: string): Promise<Buffer> {
    if (!SHA.test(sha)) throw prError("GIT_FORMAT_UNSUPPORTED", "Expected a SHA-1 Git object.");
    const bytes = (await this.run(["cat-file", type, sha])).stdout;
    if (gitHash(type, bytes) !== sha)
      throw prError("GIT_OBJECT_MISMATCH", "Local Git object does not match its identity.", {
        expectedSha: sha,
        objectType: type,
      });
    return bytes;
  }
  async snapshot(repo: string): Promise<GitSnapshot> {
    if ((await this.text(["rev-parse", "--show-object-format"])) !== "sha1")
      throw prError("GIT_FORMAT_UNSUPPORTED", "Publication currently supports SHA-1 repositories only.");
    const head = await this.text(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    await this.run(["check-ref-format", `refs/heads/${head}`]);
    if ((await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=normal"])).stdout.length)
      throw prError("WORKTREE_DIRTY", "Commit the worktree, including untracked files, before publishing.");
    const remote = await this.text(["remote", "get-url", "origin"]);
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/.exec(
      remote,
    );
    if (!match || match[1]!.replace(/\.git$/, "").toLowerCase() !== repo.toLowerCase())
      throw prError("REPOSITORY_MISMATCH", "The origin remote must be the selected github.com repository.");
    return { head, sha: await this.text(["rev-parse", "HEAD"]), tree: await this.text(["rev-parse", "HEAD^{tree}"]) };
  }
  async tree(sha: string, recursive = false): Promise<TreeEntry[]> {
    const bytes = (await this.run(["ls-tree", "-z", "--full-tree", ...(recursive ? ["-r", "-t"] : []), sha])).stdout;
    const entries: TreeEntry[] = [];
    let start = 0;
    for (let end = 0; end < bytes.length; end++) {
      if (bytes[end] !== 0) continue;
      const record = bytes.subarray(start, end);
      const tab = record.indexOf(9);
      const match = /^(100644|100755|120000|040000|160000) (blob|tree|commit) ([a-f0-9]{40})$/.exec(
        record.subarray(0, tab).toString("ascii"),
      );
      if (tab < 0 || !match) throw prError("GIT_FORMAT_UNSUPPORTED", "Unsupported Git tree entry.");
      const path = utf8(record.subarray(tab + 1));
      if (!path || (!recursive && path.includes("/")))
        throw prError("GIT_FORMAT_UNSUPPORTED", "Unsupported Git tree path.");
      entries.push({ mode: match[1]!, type: match[2] as TreeEntry["type"], sha: match[3]!, path });
      start = end + 1;
    }
    if (start !== bytes.length) throw prError("GIT_FORMAT_UNSUPPORTED", "Truncated Git tree output.");
    return entries;
  }
  async isAncestor(ancestor: string, head: string): Promise<boolean> {
    const { code } = await this.run(["merge-base", "--is-ancestor", ancestor, head], true);
    if (code > 1)
      throw prError(
        "LOCAL_HISTORY_INCOMPLETE",
        "The remote branch commit is unavailable locally. Fetch and integrate it before publication.",
      );
    return code === 0;
  }
}

function person(line: string) {
  const match = /^(.*) <([^<>\n]+)> (-?\d+) ([+-])(\d{2})(\d{2})$/.exec(line);
  if (!match || !match[1] || Number(match[5]) > 23 || Number(match[6]) > 59)
    throw prError("GIT_FORMAT_UNSUPPORTED", "Unsupported Git author or committer header.");
  const seconds = Number(match[3]);
  const offset = (Number(match[5]) * 60 + Number(match[6])) * 60 * (match[4] === "+" ? 1 : -1);
  const date = new Date((seconds + offset) * 1000);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    throw prError("GIT_FORMAT_UNSUPPORTED", "Unsupported Git timestamp.");
  return {
    name: match[1],
    email: match[2],
    date: `${date.toISOString().slice(0, 19)}${match[4]}${match[5]}:${match[6]}`,
  };
}

export function parseCommit(bytes: Buffer): { tree: string; parents: string[]; payload: Record<string, unknown> } {
  const raw = utf8(bytes);
  const boundary = raw.indexOf("\n\n");
  if (boundary < 0) throw prError("GIT_FORMAT_UNSUPPORTED", "Commit has no message boundary.");
  const headers = raw.slice(0, boundary).split("\n");
  const tree = headers.shift()?.replace(/^tree /, "") ?? "";
  const parents: string[] = [];
  while (headers[0]?.startsWith("parent ")) parents.push(headers.shift()!.slice(7));
  if (
    !SHA.test(tree) ||
    parents.some((value) => !SHA.test(value)) ||
    headers.length !== 2 ||
    !headers[0]?.startsWith("author ") ||
    !headers[1]?.startsWith("committer ")
  )
    throw prError(
      "GIT_FORMAT_UNSUPPORTED",
      "Missing commits must use conventional headers without signatures, encoding headers or merge tags. No commit will be rewritten.",
    );
  return {
    tree,
    parents,
    payload: {
      tree,
      parents,
      author: person(headers[0].slice(7)),
      committer: person(headers[1].slice(10)),
      message: raw.slice(boundary + 2),
    },
  };
}

/** Immutable objects in dependency order. No writes, including during a dry-run. */
export async function planObjects(
  git: LocalGit,
  request: GithubRequest,
  repo: string,
  head: string,
): Promise<GitObject[]> {
  const known = new Set<string>();
  const seen = new Set<string>();
  const objects: GitObject[] = [];
  const commits: { sha: string; bytes: Buffer; parsed: ReturnType<typeof parseCommit> }[] = [];
  let totalBytes = 0;
  let walked = 0;
  const add = (object: GitObject) => {
    totalBytes += object.bytes;
    if (objects.length >= LIMITS.objects || totalBytes > LIMITS.bytes)
      throw prError(
        "PUBLICATION_LIMIT",
        "Publication exceeds the object or byte limit; split the branch into smaller publications.",
      );
    objects.push(object);
    known.add(object.sha);
  };
  const walkCommit = async (sha: string): Promise<void> => {
    if (seen.has(sha)) return;
    seen.add(sha);
    if (++walked > LIMITS.commits + 20)
      throw prError("PUBLICATION_LIMIT", "Commit ancestry exceeds the publication limit.");
    const remote = await optionalRequest(request, `repos/${repo}/git/commits/${sha}`);
    if (remote !== null) {
      const commit = parseGithub(commitSchema, remote);
      const tree = await git.text(["rev-parse", `${sha}^{tree}`]);
      if (commit.sha !== sha || commit.tree.sha !== tree)
        throw prError("GIT_OBJECT_MISMATCH", "Remote commit differs from its local object.", {
          expectedSha: sha,
          actualSha: commit.sha,
          objectType: "commit",
        });
      known.add(sha);
      known.add(tree);
      for (const entry of await git.tree(tree, true)) known.add(entry.sha);
      return;
    }
    const bytes = await git.object("commit", sha);
    const parsed = parseCommit(bytes);
    if (!parsed.parents.length)
      throw prError(
        "LOCAL_HISTORY_INCOMPLETE",
        "A shared remote ancestor is required; initial repository publication is unsupported.",
      );
    for (const parent of parsed.parents) await walkCommit(parent);
    commits.push({ sha, bytes, parsed });
    if (commits.length > LIMITS.commits)
      throw prError("PUBLICATION_LIMIT", "Too many missing commits in this publication.");
  };
  await walkCommit(head);
  const walkObject = async (type: "tree" | "blob", sha: string): Promise<void> => {
    if (known.has(sha)) return;
    const remote = await optionalRequest(request, `repos/${repo}/git/${type === "tree" ? "trees" : "blobs"}/${sha}`);
    if (remote !== null) {
      if (parseGithub(oidSchema, remote).sha !== sha)
        throw prError("GIT_OBJECT_MISMATCH", "Remote object identity does not match.", {
          expectedSha: sha,
          objectType: type,
        });
      known.add(sha);
      return;
    }
    const bytes = await git.object(type, sha);
    if (type === "blob") {
      if (bytes.length > LIMITS.blobBytes)
        throw prError("PUBLICATION_LIMIT", "A blob exceeds the publication size limit.");
      if (bytes.subarray(0, 100).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1"))
        throw prError("GIT_FORMAT_UNSUPPORTED", "Uploading missing Git LFS objects is unsupported.");
      add({ type, sha, bytes: bytes.length, payload: { content: bytes.toString("base64"), encoding: "base64" } });
    } else {
      const entries = await git.tree(sha);
      for (const entry of entries) {
        if (entry.type === "commit") {
          if (!known.has(entry.sha))
            throw prError("GIT_FORMAT_UNSUPPORTED", "Publishing new submodules is unsupported.");
        } else await walkObject(entry.type, entry.sha);
      }
      add({ type, sha, bytes: bytes.length, payload: { tree: entries } });
    }
  };
  for (const commit of commits) {
    await walkObject("tree", commit.parsed.tree);
    add({ type: "commit", sha: commit.sha, bytes: commit.bytes.length, payload: commit.parsed.payload });
  }
  return objects;
}
