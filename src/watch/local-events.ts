/**
 * Local watch events — derivacao de eventos a partir de estado observado.
 *
 * O Console entrega eventos já prontos (webhook). Um watch local não: ele observa
 * estado, então o evento precisa ser *derivado* da diferença entre duas leituras.
 * Essa derivação é pura de propósito, porque é aqui que mora o risco (evento
 * faltando, evento duplicado, transição inventada) e é aqui que dá pra testar.
 */

export interface LocalPullRequestState {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  /** SHA do commit de topo: é o que distingue "commits novos na PR". */
  headSha?: string;
}

export interface LocalWorkflowRunState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch?: string;
}

export interface LocalWatchSnapshot {
  version: 1;
  pullRequests: Record<string, LocalPullRequestState>;
  workflowRuns: Record<string, LocalWorkflowRunState>;
}

/** PR que saiu da lista de abertas: só o estado final interessa. */
export interface DepartedPullRequest {
  state: string;
  title: string;
  url: string;
}

export interface DerivedLocalEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface DeriveLocalEventsInput {
  previous: LocalWatchSnapshot | null;
  current: LocalWatchSnapshot;
  departed: Record<string, DepartedPullRequest>;
}

export interface DeriveLocalEventsResult {
  events: DerivedLocalEvent[];
  snapshot: LocalWatchSnapshot;
}

/**
 * Eventos que esta derivação sabe emitir.
 *
 * É a fonte única do que o placement local do GitHub suporta: o catálogo do
 * connector lê este conjunto, então a declaração não pode divergir do que o
 * runner realmente publica.
 */
export const LOCAL_GITHUB_DERIVABLE_EVENTS = [
  "pull_request.opened",
  "pull_request.closed",
  "pull_request.merged",
  "pull_request.ready_for_review",
  "pull_request.converted_to_draft",
  "pull_request.synchronize",
  "workflow_run.completed",
  "workflow_run.failed",
  "workflow_run.succeeded",
  "workflow_run.cancelled",
] as const;

const WORKFLOW_OUTCOME_EVENTS: Record<string, string> = {
  success: "workflow_run.succeeded",
  failure: "workflow_run.failed",
  timed_out: "workflow_run.failed",
  startup_failure: "workflow_run.failed",
  cancelled: "workflow_run.cancelled",
  action_required: "workflow_run.completed",
  neutral: "workflow_run.completed",
  skipped: "workflow_run.completed",
  stale: "workflow_run.completed",
};

function pullRequestPayload(repo: string, pr: LocalPullRequestState): Record<string, unknown> {
  return {
    repository: repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    draft: pr.draft,
    ...(pr.headSha ? { headSha: pr.headSha } : {}),
  };
}

function workflowRunPayload(repo: string, run: LocalWorkflowRunState): Record<string, unknown> {
  return {
    repository: repo,
    runId: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    ...(run.branch ? { branch: run.branch } : {}),
  };
}

/**
 * Compara duas leituras e devolve só as transições.
 *
 * `previous === null` é a linha de base: nada é emitido, senão o primeiro tick
 * depois de criar um watch despejaria o estado inteiro do repositório como se
 * tudo tivesse acabado de acontecer.
 */
export function deriveLocalGitHubEvents(repo: string, input: DeriveLocalEventsInput): DeriveLocalEventsResult {
  const events: DerivedLocalEvent[] = [];
  if (input.previous === null) {
    return { events, snapshot: input.current };
  }

  const previousPrs = input.previous.pullRequests;
  const currentPrs = input.current.pullRequests;

  for (const [key, pr] of Object.entries(currentPrs)) {
    const before = previousPrs[key];
    if (!before) {
      events.push({ eventType: "pull_request.opened", payload: pullRequestPayload(repo, pr) });
      continue;
    }
    if (before.draft !== pr.draft) {
      events.push({
        eventType: pr.draft ? "pull_request.converted_to_draft" : "pull_request.ready_for_review",
        payload: pullRequestPayload(repo, pr),
      });
    }
    // Commits novos na PR. Se qualquer um dos lados não tem SHA conhecido, não
    // afirma nada: um estado de baseline incompleto não é evidência de push.
    if (before.headSha && pr.headSha && before.headSha !== pr.headSha) {
      events.push({ eventType: "pull_request.synchronize", payload: pullRequestPayload(repo, pr) });
    }
  }

  for (const key of Object.keys(previousPrs)) {
    if (currentPrs[key]) continue;
    const departed = input.departed[key];
    const state = departed?.state ?? "CLOSED";
    events.push({
      eventType: state === "MERGED" ? "pull_request.merged" : "pull_request.closed",
      payload: {
        repository: repo,
        number: Number.parseInt(key, 10),
        title: departed?.title ?? previousPrs[key]?.title ?? "",
        url: departed?.url ?? previousPrs[key]?.url ?? "",
        state,
      },
    });
  }

  for (const [key, run] of Object.entries(input.current.workflowRuns)) {
    if (run.status !== "completed") continue;
    const before = input.previous.workflowRuns[key];
    // Só a transição para completed interessa: um run que já estava completed
    // não gera evento de novo em cada tick.
    if (before && before.status === "completed") continue;

    const payload = workflowRunPayload(repo, run);
    const outcomeEvent = WORKFLOW_OUTCOME_EVENTS[run.conclusion ?? ""] ?? "workflow_run.completed";
    if (outcomeEvent !== "workflow_run.completed") {
      events.push({ eventType: outcomeEvent, payload });
    }
    events.push({ eventType: "workflow_run.completed", payload });
  }

  return { events, snapshot: input.current };
}
