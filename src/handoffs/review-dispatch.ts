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
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface ReviewTarget {
  repo: string;
  pr: number;
  sha: string;
}

/** `owner/repo#123` → `{ repo, pr }`; null when it is not that shape. */
export function parsePullRequestRef(value: string): { repo: string; pr: number } | null {
  const match = /^([^#\s]+)#(\d+)$/.exec(value.trim());
  if (!match || !REPO.test(match[1]!)) return null;
  const pr = Number(match[2]);
  return Number.isSafeInteger(pr) && pr > 0 ? { repo: match[1]!, pr } : null;
}

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value.trim());
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

export type ReviewDispatchDecision = { dispatch: true } | { dispatch: false; reason: string };

/** Pure: the same guards the parent applies by hand before dispatching a review. */
export function decideReviewDispatch(target: ReviewTarget, evidence: ReviewEvidence): ReviewDispatchDecision {
  if (evidence.prState !== "open") return { dispatch: false, reason: `PR #${target.pr} is not open` };
  if (evidence.headSha !== target.sha)
    return { dispatch: false, reason: `PR head is ${evidence.headSha.slice(0, 8)}, not ${target.sha.slice(0, 8)}` };
  if (!evidence.gate) return { dispatch: false, reason: "no quality gate check-run on this SHA" };
  if (evidence.gate.conclusion === null) return { dispatch: false, reason: "quality gate still running" };
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
} {
  const model = (author.model ?? "").toLowerCase();
  const authorIsOpus = (author.provider ?? "claude") === "claude" && model.includes("opus");
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
    ...(input.note ? [`- O que o autor pediu: ${input.note}`] : []),
    "",
    "Despachada pelo runtime porque a thread do autor declarou que espera revisão neste SHA, com o gate verde.",
    "",
    "Como revisar:",
    "1. Confira que o head da PR ainda é este SHA; se mudou, diga e pare.",
    "2. Leia o diff contra a base e os comentários dos bots neste SHA (Devin, CodeRabbit) e as respostas do autor. Foque autoridade, desenho e regressões; não repita o que os bots já cobriram.",
    "3. Não edite a PR nem comente nela. Não rode a suíte inteira nesta máquina; só testes focados, se precisar.",
    `4. Escreva os achados num arquivo (IDs estáveis: B1… bloqueante, N1… não bloqueante; arquivo:linha, prova, correção pedida) e dê o veredito por SHA: MERGEÁVEL ou NÃO MERGEÁVEL em ${sha7}.`,
    `5. Entregue com \`ravi sessions report\`: o veredito numa linha e o caminho do arquivo. Se for MERGEÁVEL, termine o report com \`--awaiting merge --ref ${target.sha}\`; se não for, com \`--awaiting instruction --ref ${target.sha}\`.`,
  ].join("\n");
}
