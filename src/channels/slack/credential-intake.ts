import { actorCanGrantRequestedPermission } from "../../approval/grantor.js";
import { authorizeIntakeSubject } from "../../credentials/intake-authorization.js";
import {
  bindIntakeView,
  cancelIntakeRequest,
  claimIntakeRequest,
  completeIntakeRequest,
  getIntakeRequest,
  normalizeIntakeTarget,
  storeIntakeSecret,
  IntakeError,
  type IntakeRequest,
} from "../../credentials/intake.js";
import type { SlackWebApiClient } from "./client.js";
import type { SlackSocketEnvelope } from "./types.js";

export const CREDENTIAL_INTAKE_PREFIX = "ravi_credential_intake";
export const CREDENTIAL_INTAKE_OPEN = `${CREDENTIAL_INTAKE_PREFIX}:open`;
export const CREDENTIAL_INTAKE_SUBMIT = `${CREDENTIAL_INTAKE_PREFIX}:submit`;
export const CREDENTIAL_INTAKE_SECRET_BLOCK = `${CREDENTIAL_INTAKE_PREFIX}:secret`;
export const CREDENTIAL_INTAKE_SECRET_ACTION = `${CREDENTIAL_INTAKE_PREFIX}:value`;
export const CREDENTIAL_INTAKE_APP_BLOCK = `${CREDENTIAL_INTAKE_PREFIX}:app_token`;
export const CREDENTIAL_INTAKE_BOT_BLOCK = `${CREDENTIAL_INTAKE_PREFIX}:bot_token`;

type Ack = (envelopeId: string, payload?: Record<string, unknown>) => Promise<void> | void;
type Client = Pick<SlackWebApiClient, "viewsOpen" | "viewsUpdate"> & Partial<Pick<SlackWebApiClient, "postEphemeral">>;

export interface CredentialIntakeDependencies {
  getRequest: typeof getIntakeRequest;
  bindView: typeof bindIntakeView;
  claim: typeof claimIntakeRequest;
  cancel: typeof cancelIntakeRequest;
  complete: typeof completeIntakeRequest;
  store: typeof storeIntakeSecret;
  authorize: (request: IntakeRequest, userId: string, instanceId: string) => string | null;
}

const defaultDependencies: CredentialIntakeDependencies = {
  getRequest: getIntakeRequest,
  bindView: bindIntakeView,
  claim: claimIntakeRequest,
  cancel: cancelIntakeRequest,
  complete: completeIntakeRequest,
  store: storeIntakeSecret,
  authorize: (request, userId, instanceId) => {
    // The human handoff outlives its issuing turn; recheck the agent's current
    // authority, not the expired turn context or a client-supplied capability.
    if (
      request.issuerAgentId &&
      !authorizeIntakeSubject("agent", request.issuerAgentId, "credentials.requests", request.target)
    )
      return null;
    const actor = actorCanGrantRequestedPermission({
      channel: "slack",
      accountId: request.accountId,
      instanceId,
      senderId: userId,
      permission: "mutate",
      objectType: "credentials.secrets",
      objectId: request.target,
    });
    return actor.allowed &&
      actor.subjectType === "contact" &&
      actor.subjectId &&
      authorizeIntakeSubject("contact", actor.subjectId, "credentials.secrets", request.target)
      ? actor.subjectId
      : null;
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function reserved(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(CREDENTIAL_INTAKE_PREFIX);
}

function scrubPayload(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const object = value as Record<string, unknown>;
    scrubPayload(object[key]);
    delete object[key];
  }
}

/** Recognize reserved identifiers even when a malformed payload loses its callback. */
export function isCredentialIntakeEnvelope(envelope: SlackSocketEnvelope): boolean {
  const payload = record(envelope.payload);
  if (!payload) return false;
  const view = record(payload.view);
  if (reserved(view?.callback_id) || reserved(payload.callback_id)) return true;
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  if (actions.some((action) => reserved(record(action)?.action_id) || reserved(record(action)?.block_id))) return true;
  const values = record(record(view?.state)?.values) ?? record(record(payload.state)?.values);
  if (
    values &&
    (Object.keys(values).some(reserved) ||
      Object.values(values).some((value) => {
        const actions = record(value);
        return actions && Object.keys(actions).some(reserved);
      }))
  )
    return true;
  const blocks = [
    ...(Array.isArray(view?.blocks) ? view.blocks : []),
    ...(Array.isArray(record(payload.message)?.blocks) ? (record(payload.message)!.blocks as unknown[]) : []),
  ];
  return blocks.some(
    (block) => reserved(record(block)?.block_id) || reserved(record(record(block)?.element)?.action_id),
  );
}

function plain(text: string): Record<string, unknown> {
  return { type: "plain_text", text };
}

function section(text: string): Record<string, unknown> {
  return { type: "section", text: plain(text) };
}

function destination(request: IntakeRequest): string {
  const target = normalizeIntakeTarget(request.target);
  return target.kind === "env"
    ? `Destino: ${target.key}\nEscopo: este servidor (todos os processos que usam esta chave).`
    : `Provedor: ${target.provider}\nConexão: ${target.connection}\nEscopo: conexão do provedor; permissões atuais dos agentes.`;
}

export function buildCredentialIntakeInvitation(request: IntakeRequest): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  return {
    text: "Adicionar credencial com segurança",
    blocks: [
      section(request.reason),
      section(destination(request)),
      {
        type: "actions",
        block_id: `${CREDENTIAL_INTAKE_PREFIX}:invitation`,
        elements: [
          {
            type: "button",
            action_id: CREDENTIAL_INTAKE_OPEN,
            value: request.id,
            text: plain("Adicionar credencial"),
            style: "primary",
          },
        ],
      },
    ],
  };
}

export function buildCredentialIntakeModal(request: IntakeRequest): Record<string, unknown> {
  const target = normalizeIntakeTarget(request.target);
  const slackBundle = target.kind === "connection" && target.provider === "slack";
  return {
    type: "modal",
    callback_id: CREDENTIAL_INTAKE_SUBMIT,
    private_metadata: request.id,
    notify_on_close: true,
    title: plain("Adicionar credencial"),
    submit: plain("Salvar"),
    close: plain("Cancelar"),
    blocks: [
      section(request.reason),
      section(`${destination(request)}${request.label ? `\nNome: ${request.label}` : ""}`),
      section("O Slack processa este token; use token de API revogável. O valor fica visível enquanto você o edita."),
      ...(slackBundle
        ? [
            credentialInput(
              CREDENTIAL_INTAKE_APP_BLOCK,
              "Token do app",
              "Cole o token do app Slack, que começa com xapp-.",
            ),
            credentialInput(
              CREDENTIAL_INTAKE_BOT_BLOCK,
              "Token do bot",
              "Cole o token do bot Slack, que começa com xoxb-.",
            ),
          ]
        : [
            credentialInput(
              CREDENTIAL_INTAKE_SECRET_BLOCK,
              "Token de API",
              "Cole o token somente aqui. Não envie no chat.",
            ),
          ]),
    ],
  };
}

function credentialInput(blockId: string, label: string, hint: string): Record<string, unknown> {
  return {
    type: "input",
    block_id: blockId,
    label: plain(label),
    hint: plain(hint),
    element: { type: "plain_text_input", action_id: CREDENTIAL_INTAKE_SECRET_ACTION, min_length: 1, max_length: 3000 },
  };
}

export function buildCredentialIntakeStatus(
  state: "saving" | "stored" | "failed" | "verify",
  receipt?: { fingerprint: string; daemonReloadRequired: boolean },
): Record<string, unknown> {
  const text =
    state === "saving"
      ? "Salvando credencial… O campo foi removido."
      : state === "stored" && receipt
        ? `Credencial salva.\nFingerprint: ${receipt.fingerprint.slice(0, 12)}${receipt.daemonReloadRequired ? "\nO servidor precisa recarregar a configuração para usar esta chave." : ""}`
        : state === "verify"
          ? "A gravação precisa ser conferida antes de tentar novamente. Não envie o token de novo."
          : "Não foi possível salvar esta credencial. O campo foi removido. Solicite um novo convite e confira suas permissões.";
  return {
    type: "modal",
    callback_id: `${CREDENTIAL_INTAKE_PREFIX}:status`,
    title: plain(
      state === "stored"
        ? "Credencial salva"
        : state === "saving"
          ? "Salvando credencial"
          : state === "verify"
            ? "Verificar gravação"
            : "Credencial não salva",
    ),
    close: plain("Fechar"),
    blocks: [section(text)],
  };
}

/**
 * A dedicated, non-publishing boundary. Capture only needed scalars, then erase
 * the payload synchronously before ACK, authorization, storage or any await.
 * Errors deliberately have no raw cause/log; no generic handler sees this data.
 */
export async function handleCredentialIntakeEnvelope(input: {
  envelope: SlackSocketEnvelope;
  accountId: string;
  instanceId: string;
  directSocketMode: boolean;
  client: Client;
  ack: Ack;
  dependencies?: Partial<CredentialIntakeDependencies>;
}): Promise<boolean> {
  if (!isCredentialIntakeEnvelope(input.envelope)) return false;
  const payload = record(input.envelope.payload)!;
  const view = record(payload.view);
  const firstAction = record(Array.isArray(payload.actions) ? payload.actions[0] : undefined);
  const kind = string(payload.type);
  const actionId = string(firstAction?.action_id);
  const callbackId = string(view?.callback_id);
  const requestId = string(view?.private_metadata) ?? string(firstAction?.value);
  const teamId = string(record(payload.team)?.id) ?? string(payload.team_id);
  const userId = string(record(payload.user)?.id);
  const channelId = string(record(payload.channel)?.id) ?? string(record(payload.container)?.channel_id);
  const viewId = string(view?.id);
  const triggerId = string(payload.trigger_id);
  const envelopeId = string(input.envelope.envelope_id) ?? "";
  const values = record(record(view?.state)?.values);
  let secret = string(
    record(record(values?.[CREDENTIAL_INTAKE_SECRET_BLOCK])?.[CREDENTIAL_INTAKE_SECRET_ACTION])?.value,
  );
  let appToken = string(
    record(record(values?.[CREDENTIAL_INTAKE_APP_BLOCK])?.[CREDENTIAL_INTAKE_SECRET_ACTION])?.value,
  );
  let botToken = string(
    record(record(values?.[CREDENTIAL_INTAKE_BOT_BLOCK])?.[CREDENTIAL_INTAKE_SECRET_ACTION])?.value,
  );
  scrubPayload(payload);
  payload.type = "credential_intake_consumed";

  const deps = { ...defaultDependencies, ...input.dependencies };
  let acknowledged = false;
  let pendingRequestId: string | undefined;
  let storeStarted = false;
  let openedViewId: string | undefined;
  let feedbackRequest: IntakeRequest | undefined;
  const ack = async (response?: Record<string, unknown>) => {
    if (acknowledged) return;
    acknowledged = true;
    if (envelopeId) await input.ack(envelopeId, response);
  };
  try {
    if (!input.directSocketMode || !requestId || !teamId || !userId) throw new Error("INTAKE_DENIED");
    const request = deps.getRequest(requestId);
    if (!request || request.accountId !== input.accountId || request.teamId !== teamId || request.userId !== userId)
      throw new Error("INTAKE_DENIED");
    const actorContactId = deps.authorize(request, userId, input.instanceId);
    if (!actorContactId) throw new Error("INTAKE_DENIED");
    feedbackRequest = request;
    const binding = { accountId: input.accountId, teamId, userId, actorContactId, ...(viewId ? { viewId } : {}) };
    if (kind === "view_closed") {
      deps.cancel(requestId, binding);
      await ack();
      return true;
    }
    if (kind === "block_actions" && actionId === CREDENTIAL_INTAKE_OPEN && !viewId) {
      if (
        !triggerId ||
        channelId !== request.channelId ||
        request.viewId ||
        request.status !== "open" ||
        request.expiresAt <= Date.now()
      )
        throw new Error("INTAKE_DENIED");
      await ack();
      const result = await input.client.viewsOpen({ triggerId, view: buildCredentialIntakeModal(request) });
      openedViewId = string(result.view?.id);
      if (!result.ok || !openedViewId) throw new Error("INTAKE_DENIED");
      deps.bindView(requestId, binding, openedViewId);
      return true;
    }
    const target = normalizeIntakeTarget(request.target);
    if (target.kind === "connection" && target.provider === "slack") {
      if (!appToken || !botToken || appToken.length > 3000 || botToken.length > 3000) throw new Error("INTAKE_DENIED");
      secret = JSON.stringify({ appToken, botToken });
      appToken = undefined;
      botToken = undefined;
    }
    if (
      kind !== "view_submission" ||
      callbackId !== CREDENTIAL_INTAKE_SUBMIT ||
      !viewId ||
      !request.viewId ||
      !secret ||
      secret.length > 8192
    )
      throw new Error("INTAKE_DENIED");
    const claimed = deps.claim(requestId, binding);
    pendingRequestId = claimed.id;
    await ack({ response_action: "update", view: buildCredentialIntakeStatus("saving") });
    storeStarted = true;
    const receipt = await deps.store(claimed, secret);
    secret = undefined;
    // A failed UI refresh must not turn a successful store into a false failure.
    const displayed = await input.client
      .viewsUpdate({ viewId, view: buildCredentialIntakeStatus("stored", receipt) })
      .then(
        () => true,
        () => false,
      );
    if (!displayed && input.client.postEphemeral) {
      await input.client
        .postEphemeral({
          channel: request.channelId,
          user: request.userId,
          threadTs: request.threadTs,
          text: `Credencial salva. Fingerprint: ${receipt.fingerprint.slice(0, 12)}.${receipt.daemonReloadRequired ? " O servidor precisa recarregar a configuração." : ""}`,
        })
        .catch(() => {
          // no-cause: Receipt delivery is best effort after durable storage; Slack diagnostics must not escape.
        });
    }
  } catch (error) {
    secret = undefined;
    appToken = undefined;
    botToken = undefined;
    const failureState =
      (error instanceof IntakeError && error.code === "INTAKE_RECONCILIATION_REQUIRED") ||
      (storeStarted && !(error instanceof IntakeError))
        ? "verify"
        : "failed";
    if (pendingRequestId && !storeStarted) {
      try {
        deps.complete(pendingRequestId, { status: "failed", errorCode: "INTAKE_STORE_FAILED" });
      } catch {
        // no-cause: Failed terminalization leaves the request blocked; persistence diagnostics must not enter Slack responses.
      }
    }
    if (openedViewId) {
      await input.client
        .viewsUpdate({ viewId: openedViewId, view: buildCredentialIntakeStatus(failureState) })
        .catch(() => {
          // no-cause: Closing an opened modal is best effort; preserve the safe failure without Slack diagnostics.
        });
    }
    if (!acknowledged) {
      await ack(
        kind === "view_submission"
          ? { response_action: "update", view: buildCredentialIntakeStatus(failureState) }
          : undefined,
      ).catch(() => {
        // no-cause: Failed interaction acknowledgment must not forward raw Slack payload or response diagnostics.
      });
    } else if (kind === "view_submission" && viewId) {
      await input.client.viewsUpdate({ viewId, view: buildCredentialIntakeStatus(failureState) }).catch(() => {
        // no-cause: Failure-view delivery is best effort; keep raw Slack diagnostics outside the intake response.
      });
    }
    if (kind === "block_actions" && feedbackRequest && input.client.postEphemeral) {
      await input.client
        .postEphemeral({
          channel: feedbackRequest.channelId,
          user: feedbackRequest.userId,
          threadTs: feedbackRequest.threadTs,
          text: "Este convite não está disponível. Solicite um novo convite e confira suas permissões.",
        })
        .catch(() => {
          // no-cause: Private denial feedback is best effort; do not expose raw Slack delivery diagnostics.
        });
    }
  } finally {
    secret = undefined;
    appToken = undefined;
    botToken = undefined;
  }
  return true;
}
