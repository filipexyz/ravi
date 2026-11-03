import { z } from "zod";
import { prError, REPO, SHA } from "./contracts.js";
import { runProcess } from "./process.js";

export type GithubRequest = (
  endpoint: string,
  method: string,
  body?: Record<string, unknown>,
) => Promise<unknown> | unknown;
export class GithubError extends Error {
  constructor(readonly status: number) {
    super(`GitHub request failed (${status}).`);
  }
}
export function githubClient(signal?: AbortSignal): GithubRequest {
  return async (endpoint, method, body) => {
    const args = ["api", "--hostname", "github.com", "--include", "--method", method, endpoint];
    if (body) args.push("--input", "-");
    const result = await runProcess("gh", args, {
      signal,
      input: body ? JSON.stringify(body) : undefined,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    const raw = result.stdout.toString("utf8");
    const header = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n/.exec(raw);
    if (!header)
      throw prError(
        "GITHUB_UNAVAILABLE",
        "GitHub returned no usable response. Check gh authentication and connectivity.",
        { retryable: true },
      );
    const status = Number(header[1]);
    if (status < 200 || status >= 300 || result.code !== 0) throw new GithubError(status);
    try {
      return JSON.parse(raw.slice(header[0].length));
    } catch {
      throw prError("GITHUB_RESPONSE_INVALID", "GitHub returned an invalid JSON response.");
    }
  };
}

export const pullSchema = z.object({
  number: z.number().int().positive(),
  node_id: z.string().min(1),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  head: z.object({ ref: z.string(), sha: z.string().regex(SHA), repo: z.object({ full_name: z.string() }) }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});
export type PullRequest = z.infer<typeof pullSchema>;
export function parseGithub<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw prError("GITHUB_RESPONSE_INVALID", "GitHub returned incomplete or inconsistent publication evidence.");
  return parsed.data;
}
export const oidSchema = z.object({ sha: z.string().regex(SHA) });
export const commitSchema = oidSchema.extend({ tree: oidSchema });
export const refSchema = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal("commit"), sha: z.string().regex(SHA) }),
});
export const refPath = (repo: string, head: string) => `repos/${repo}/git/ref/heads/${encodeURIComponent(head)}`;
export async function optionalRequest(request: GithubRequest, endpoint: string): Promise<unknown | null> {
  try {
    return await request(endpoint, "GET");
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) return null;
    throw error;
  }
}
export async function readRef(request: GithubRequest, repo: string, head: string): Promise<string | null> {
  const value = await optionalRequest(request, refPath(repo, head));
  if (value === null) return null;
  const ref = parseGithub(refSchema, value);
  if (ref.ref !== `refs/heads/${head}`)
    throw prError("REMOTE_REF_CHANGED", "GitHub returned a different branch reference.");
  return ref.object.sha;
}

/** Read all PRs for this head, not just the requested base; never silently retarget/reopen. */
export async function findPublicationPr(
  request: GithubRequest,
  repo: string,
  head: string,
  base: string,
): Promise<PullRequest | null> {
  if (!REPO.test(repo)) throw prError("USAGE_ERROR", "Expected --repo owner/repo.", {}, 2);
  const found: PullRequest[] = [];
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      state: "all",
      head: `${repo.split("/")[0]}:${head}`,
      per_page: "100",
      page: String(page),
    });
    const batch = parseGithub(z.array(pullSchema).max(100), await request(`repos/${repo}/pulls?${query}`, "GET"));
    found.push(...batch);
    if (batch.length < 100) break;
    if (page === 10) throw prError("PR_CONFLICT", "PR lookup exceeded the supported history bound.");
  }
  if (
    found.some(
      (pr) =>
        pr.head.ref !== head ||
        pr.head.repo.full_name.toLowerCase() !== repo.toLowerCase() ||
        pr.base.repo.full_name.toLowerCase() !== repo.toLowerCase(),
    )
  )
    throw prError("PR_CONFLICT", "PR lookup returned a different repository or branch.");
  const open = found.filter((pr) => pr.state === "open");
  if (open.length === 1 && open[0]!.base.ref === base) return open[0]!;
  if (found.length)
    throw prError(
      "PR_CONFLICT",
      "This branch has a closed PR, another base, or multiple open PRs. Select a new branch or resolve the existing PR explicitly.",
    );
  return null;
}
