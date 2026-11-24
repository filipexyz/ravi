import { z } from "zod";
import { dbGetSetting } from "../router/router-db.js";

/**
 * Review dispatch: when a thread declares it waits for a review of a PR at a SHA, the runtime opens the
 * independent review itself instead of waiting for the parent to do it by hand.
 *
 * The guards are the ones the parent applies today, in code: the SHA is the PR's head, the PR is open,
 * and the quality gate of that SHA was read as `success` in its check-run. The reviewer runs on a model
 * other than the author's. This module decides and writes the brief; opening the reviewer's session is
 * the caller's (a channel adapter), so the core names no channel.
 */

export const REVIEW_AUTO_DISPATCH_SETTING = "handoffs.review.autoDispatch";
export const REVIEW_GATE_CHECK_SETTING = "handoffs.review.gateCheck";
export const DEFAULT_REVIEW_GATE_CHECK = "Quality Gate";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** `.` and `..` are path segments, never a GitHub name. */
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface ReviewTarget {
  repo: string;
  pr: number;
  sha: string;
}

/** `owner/repo#123` → `{ repo, pr }`; null when it is not that shape. */
export function parsePullRequestRef(value: string): { repo: string; pr: number } | null {
  const match = /^([^#\s]+)#(\d+)$/.exec(value.trim());
  if (!match || !REPO.test(match[1]!) || DOT_SEGMENT.test(match[1]!)) return null;
  const pr = Number(match[2]);
  // GitHub names are case-insensitive: one spelling, so one PR head has one review key.
  return Number.isSafeInteger(pr) && pr > 0 ? { repo: match[1]!.toLowerCase(), pr } : null;
}

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value.trim());
}

/**
 * A handoff that names a PR stores `owner/repo#n@<sha>` as its ref, so the reconciler can close it when the
 * PR is merged or closed. A plain ref (a SHA, a PR number) stays as the caller wrote it.
 */
export function formatPullRequestHandoffRef(target: ReviewTarget): string {
  return `${target.repo}#${target.pr}@${target.sha}`;
}

export function parsePullRequestHandoffRef(ref: string | null): ReviewTarget | null {
  const match = ref ? /^([^#\s]+#\d+)@([0-9a-f]{40})$/.exec(ref.trim()) : null;
  const pull = match ? parsePullRequestRef(match[1]!) : null;
  return pull ? { ...pull, sha: match![2]! } : null;
}

/** The SHA a handoff ref points at: the SHA of a PR ref, or the ref itself. */
export function handoffRefSha(ref: string | null): string | null {
  return parsePullRequestHandoffRef(ref)?.sha ?? ref;
}

/**
 * Which PRs a thread may have reviewed automatically: the ones it follows (the follow `ravi pr publish`
 * arms for the publishing session). A thread cannot point the runtime's GitHub credential and a reviewer
 * at a repository it did not publish to.
 */
export function followsPullRequest(
  triggers: ReadonlyArray<{ name: string; replySession?: string; enabled?: boolean }>,
  target: Pick<ReviewTarget, "repo" | "pr">,
  session: { sessionKey: string; name?: string | null },
): boolean {
  const name = `gh-follow:${target.repo}#${target.pr}`;
  return triggers.some(
    (trigger) =>
      trigger.enabled !== false &&
      trigger.name.toLowerCase() === name &&
      (trigger.replySession === session.sessionKey || (!!session.name && trigger.replySession === session.name)),
  );
}

/**
 * Whether any session of this install follows the PR. A wait may name a PR its thread did not publish (the
 * reviewer names the author's), but the runtime reads the state only of PRs this install already follows.
 */
export function pullRequestFollowedHere(
  triggers: ReadonlyArray<{ name: string; enabled?: boolean }>,
  target: Pick<ReviewTarget, "repo" | "pr">,
): boolean {
  const name = `gh-follow:${target.repo}#${target.pr}`;
  return triggers.some((trigger) => trigger.enabled !== false && trigger.name.toLowerCase() === name);
}

/** On unless the setting turns it off. */
export function reviewAutoDispatchEnabled(read: (key: string) => string | null = dbGetSetting): boolean {
  const value = read(REVIEW_AUTO_DISPATCH_SETTING)?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0");
}

export function reviewGateCheckName(read: (key: string) => string | null = dbGetSetting): string {
  return read(REVIEW_GATE_CHECK_SETTING)?.trim() || DEFAULT_REVIEW_GATE_CHECK;
}

export interface GateReading {
  name: string;
  checkRunId: number | null;
  conclusion: string | null;
  completedAt: string | null;
}

export interface ReviewEvidence {
  prState: "open" | "closed";
  headSha: string;
  gate: GateReading | null;
}

export type GithubRead = (endpoint: string) => Promise<unknown>;

let githubReadOverride: GithubRead | null = null;

/** Reads GitHub through the same authenticated `gh` client `ravi pr publish` uses. */
export function reviewGithubRead(): GithubRead {
  if (githubReadOverride) return githubReadOverride;
  return async (endpoint) => {
    const { githubClient } = await import("../pr/github.js");
    return githubClient()(endpoint, "GET");
  };
}

export function setReviewGithubReadForTest(read: GithubRead | null): void {
  githubReadOverride = read;
}

const pullSchema = z.object({
  state: z.enum(["open", "closed"]),
  head: z.object({ sha: z.string() }),
});
const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      completed_at: z.string().nullable(),
    }),
  ),
});

/** Reads the PR head and the named gate check-run of the SHA. The newest run of that name wins. */
export async function readReviewEvidence(
  target: ReviewTarget,
  read: GithubRead,
  gateName = reviewGateCheckName(),
): Promise<ReviewEvidence> {
  const pull = pullSchema.parse(await read(`repos/${target.repo}/pulls/${target.pr}`));
  const runs = checkRunsSchema.parse(
    await read(
      `repos/${target.repo}/commits/${target.sha}/check-runs?check_name=${encodeURIComponent(gateName)}&per_page=100`,
    ),
  );
  const gate = runs.check_runs
    .filter((run) => run.name === gateName && run.head_sha === target.sha)
    .sort((a, b) => b.id - a.id)[0];
  return {
    prState: pull.state,
    headSha: pull.head.sha,
    gate: gate
      ? {
          name: gate.name,
          checkRunId: gate.id,
          conclusion: gate.status === "completed" ? gate.conclusion : null,
          completedAt: gate.completed_at,
        }
      : null,
  };
}

const pullClosureSchema = z.object({
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
});

/**
 * Whether a PR already ended, read once when a wait on it is declared: a merge that happened before the wait
 * existed sent its event to nobody. Null when the PR is open; a failed read throws and the caller opens the wait.
 */
export async function readPullClosure(
  target: Pick<ReviewTarget, "repo" | "pr">,
  read: GithubRead,
): Promise<{ merged: boolean } | null> {
  const pull = pullClosureSchema.parse(await read(`repos/${target.repo}/pulls/${target.pr}`));
  return pull.state === "closed" ? { merged: pull.merged === true || !!pull.merged_at } : null;
}

export type ReviewDispatchDecision = { dispatch: true } | { dispatch: false; reason: string };

export const REVIEW_NOTE_MAX = 280;

/**
 * The reviewer that a thread already got for this PR head. A review whose thread failed or was closed is not
 * a review in progress: the wait goes back to the parent instead of being reported as dispatched.
 */
export function replayedReviewDecision(status: string): { usable: true } | { usable: false; reason: string } {
  if (status === "failed" || status === "closed")
    return {
      usable: false,
      reason: `the review opened for this head is ${status}; open a new one by hand (ravi sessions create-thread) or publish a new SHA`,
    };
  return { usable: true };
}

/** Pure: the same guards the parent applies by hand before dispatching a review. */
export function decideReviewDispatch(target: ReviewTarget, evidence: ReviewEvidence): ReviewDispatchDecision {
  // One reason for both: the answer must not tell a caller the state or the head of a PR it cannot read.
  if (evidence.prState !== "open" || evidence.headSha !== target.sha)
    return { dispatch: false, reason: "the PR is not open at this SHA" };
  if (!evidence.gate) return { dispatch: false, reason: "no quality gate check-run on this SHA" };
  if (evidence.gate.conclusion === null)
    return { dispatch: false, reason: "quality gate still running; report again with the same flags when it passes" };
  if (evidence.gate.conclusion !== "success")
    return { dispatch: false, reason: `quality gate concluded ${evidence.gate.conclusion}` };
  return { dispatch: true };
}

/**
 * The reviewer is never the author's model: an Opus author gets Sonnet, anyone else gets Opus. The
 * reviewer runs on the Claude runtime at high effort (adversarial review).
 */
export function pickReviewerRuntime(author: { provider?: string | null; model?: string | null }): {
  provider: "claude";
  model: "opus" | "sonnet";
  effort: "high";
} | null {
  // Without the author's model the rule "reviewer is another model" cannot be kept.
  if (!author.model?.trim()) return null;
  // The model identity decides, not the runtime: Pi can run Anthropic Opus (`anthropic/claude-opus-…`).
  const authorIsOpus = (author.model ?? "").toLowerCase().includes("opus");
  return { provider: "claude", model: authorIsOpus ? "sonnet" : "opus", effort: "high" };
}

/** Idempotency key for the reviewer's thread: one review per PR head. */
export function reviewThreadKey(target: ReviewTarget): string {
  return `review:${target.repo}#${target.pr}@${target.sha}`;
}

export function buildReviewerBrief(input: {
  target: ReviewTarget;
  gate: GateReading;
  authorSessionName: string;
  authorModel: string | null;
  note: string | null;
}): string {
  const { target, gate } = input;
  const sha7 = target.sha.slice(0, 7);
  return [
    `Revisão independente: ${target.repo} #${target.pr} @ ${sha7}`,
    "",
    `- PR: https://github.com/${target.repo}/pull/${target.pr}`,
    `- SHA a revisar: ${target.sha}`,
    `- ${gate.name}: check-run ${gate.checkRunId ?? "?"}, ${gate.conclusion}, ${gate.completedAt ?? "?"} (lido no SHA acima)`,
    `- Autor: thread ${input.authorSessionName}${input.authorModel ? ` (${input.authorModel})` : ""}`,
    ...(input.note
      ? [`- Alegação do autor, não verificada: ${input.note.slice(0, REVIEW_NOTE_MAX).replace(/\s+/g, " ")}`]
      : []),
    "",
    "Despachada pelo runtime porque a thread do autor declarou que espera revisão neste SHA, com o gate verde.",
    "",
    "Como revisar:",
    "1. Confira que o head da PR ainda é este SHA; se mudou, diga e pare.",
    "2. Leia o diff contra a base e os comentários dos bots neste SHA (Devin, CodeRabbit) e as respostas do autor. Foque autoridade, desenho e regressões; não repita o que os bots já cobriram.",
    "3. Não edite a PR nem comente nela. Não rode a suíte inteira nesta máquina; só testes focados, se precisar.",
    `4. Escreva os achados num arquivo (IDs estáveis: B1… bloqueante, N1… não bloqueante; arquivo:linha, prova, correção pedida) e dê o veredito por SHA: MERGEÁVEL ou NÃO MERGEÁVEL em ${sha7}.`,
    `5. Entregue com \`ravi sessions report\`: o veredito numa linha e o caminho do arquivo. Se for MERGEÁVEL, termine o report com \`--awaiting merge --ref ${target.sha} --pr ${target.repo}#${target.pr}\` (a espera fecha sozinha quando a PR for mergeada ou fechada); se não for, com \`--awaiting instruction --ref ${target.sha}\`.`,
  ].join("\n");
}
