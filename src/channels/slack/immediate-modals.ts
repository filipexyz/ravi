/**
 * Declarative "open modal immediately" rules for Slack Block Kit interactions.
 *
 * Slack trigger_ids expire ~3s after the click, which is often too short for the
 * trigger -> shell -> `ravi slack modals-open` path. Rules stored in the
 * `slack.immediateModals` setting let the Socket Mode service call views.open
 * itself, before the interaction is published to `ravi.inbound.interaction`.
 * Clicks from inside an open modal use views.push instead, stacking the new view.
 */

export const SLACK_IMMEDIATE_MODALS_SETTING = "slack.immediateModals";

/** Slack caps view.private_metadata at 3000 characters. */
const SLACK_PRIVATE_METADATA_MAX = 3000;
/** Slack caps modal view.title.text at 24 characters. */
const SLACK_MODAL_TITLE_MAX = 24;

export interface SlackImmediateModalRule {
  readonly actionId?: string;
  readonly blockId?: string;
  readonly callbackId?: string;
  readonly accountId?: string;
  readonly view: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(rule: Record<string, unknown>, key: string, index: number): string | undefined {
  const value = rule[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${SLACK_IMMEDIATE_MODALS_SETTING}[${index}].${key} must be a non-empty string`);
  }
  return value.trim();
}

/** Parse and validate the setting value. Throws with a precise message on invalid input. */
export function parseSlackImmediateModalRules(raw: string | null | undefined): SlackImmediateModalRule[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${SLACK_IMMEDIATE_MODALS_SETTING} must be a JSON array: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error(`${SLACK_IMMEDIATE_MODALS_SETTING} must be a JSON array`);

  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${SLACK_IMMEDIATE_MODALS_SETTING}[${index}] must be an object`);
    const actionId = optionalString(entry, "actionId", index);
    const blockId = optionalString(entry, "blockId", index);
    const callbackId = optionalString(entry, "callbackId", index);
    const accountId = optionalString(entry, "accountId", index);
    if (!actionId && !blockId) {
      throw new Error(`${SLACK_IMMEDIATE_MODALS_SETTING}[${index}] requires actionId or blockId`);
    }
    const view = entry.view;
    if (!isRecord(view) || view.type !== "modal" || !Array.isArray(view.blocks)) {
      throw new Error(`${SLACK_IMMEDIATE_MODALS_SETTING}[${index}].view must be a Slack modal view with blocks`);
    }
    const title = view.title;
    if (
      !isRecord(title) ||
      title.type !== "plain_text" ||
      typeof title.text !== "string" ||
      !title.text.trim() ||
      title.text.length > SLACK_MODAL_TITLE_MAX
    ) {
      throw new Error(
        `${SLACK_IMMEDIATE_MODALS_SETTING}[${index}].view.title must be a plain_text object with 1-${SLACK_MODAL_TITLE_MAX} characters`,
      );
    }
    return {
      ...(actionId ? { actionId } : {}),
      ...(blockId ? { blockId } : {}),
      ...(callbackId ? { callbackId } : {}),
      ...(accountId ? { accountId } : {}),
      view,
    };
  });
}

/** First rule whose every configured field matches the normalized interaction. */
export function matchSlackImmediateModalRule(
  rules: readonly SlackImmediateModalRule[],
  interaction: Record<string, unknown>,
): SlackImmediateModalRule | undefined {
  if (interaction.interactionType !== "block_actions" || typeof interaction.triggerId !== "string") return undefined;
  return rules.find(
    (rule) =>
      (rule.actionId === undefined || rule.actionId === interaction.actionId) &&
      (rule.blockId === undefined || rule.blockId === interaction.blockId) &&
      (rule.callbackId === undefined || rule.callbackId === interaction.viewCallbackId) &&
      (rule.accountId === undefined || rule.accountId === interaction.accountId),
  );
}

/**
 * Copy of the rule view ready for views.open/views.push. When the stored view has no
 * private_metadata, Ravi fills it with the click context so the later
 * view_submission handler can find the originating message.
 */
export function buildSlackImmediateModalView(
  rule: SlackImmediateModalRule,
  interaction: Record<string, unknown>,
): Record<string, unknown> {
  const view: Record<string, unknown> = { ...rule.view };
  if (typeof view.private_metadata === "string" && view.private_metadata) return view;
  const context: Record<string, unknown> = { source: "ravi.slack.immediate_modal" };
  for (const key of ["accountId", "teamId", "channelId", "messageTs", "threadTs", "userId", "actionId", "blockId"]) {
    if (typeof interaction[key] === "string") context[key] = interaction[key];
  }
  if (typeof interaction.value === "string") context.value = interaction.value;
  let metadata = JSON.stringify(context);
  if (metadata.length > SLACK_PRIVATE_METADATA_MAX) {
    delete context.value;
    metadata = JSON.stringify(context);
  }
  view.private_metadata = metadata;
  return view;
}
