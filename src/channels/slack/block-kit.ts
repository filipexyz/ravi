export type SlackBlockKitBlock = Record<string, unknown>;
export type SlackBlockKitMessagePayload = {
  readonly text: string;
  readonly blocks: readonly SlackBlockKitBlock[];
};

export type SlackBlockKitValidationTarget = "blocks" | "message" | "view";

export interface SlackBlockKitValidationPayload {
  readonly target: SlackBlockKitValidationTarget;
  readonly blocks?: readonly SlackBlockKitBlock[];
  readonly message?: Record<string, unknown>;
  readonly view?: Record<string, unknown>;
}

const MESSAGE_BLOCK_LIMIT = 50;
const ACTIONS_ELEMENTS_LIMIT = 25;
const SLACK_ID_LIMIT = 255;

const INTERACTIVE_ELEMENT_TYPES_REQUIRING_ACTION_ID = new Set([
  "button",
  "checkboxes",
  "datepicker",
  "datetimepicker",
  "email_text_input",
  "external_select",
  "multi_channels_select",
  "multi_conversations_select",
  "multi_external_select",
  "multi_static_select",
  "multi_users_select",
  "number_input",
  "overflow",
  "plain_text_input",
  "radio_buttons",
  "rich_text_input",
  "static_select",
  "timepicker",
  "url_text_input",
  "users_select",
]);

export function parseSlackBlockKitJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Block Kit JSON: ${message}`);
  }
}

export function normalizeSlackBlockKitMessagePayload(raw: unknown, textOverride?: string): SlackBlockKitMessagePayload {
  const message = normalizeSlackBlockKitMessageObject(raw);
  const text = textOverride?.trim() || stringField(message, "text") || "Ravi Slack Block Kit message";
  const blocks = normalizeSlackBlockKitBlocks(message.blocks);
  validateSlackBlockKitMessage({ text, blocks });
  return { text, blocks };
}

export function normalizeSlackBlockKitValidationPayload(
  raw: unknown,
  targetOverride?: string,
): SlackBlockKitValidationPayload {
  const target = parseSlackBlockKitValidationTarget(targetOverride);
  if (target === "blocks") {
    const blocks = normalizeSlackBlockKitBlocks(Array.isArray(raw) ? raw : recordField(raw, "blocks"));
    validateSlackBlockKitBlocks(blocks, { enforceMessageLimit: false });
    return { target, blocks };
  }

  if (target === "view") {
    const view = normalizeSlackBlockKitRecord(raw, "Block Kit view payload");
    validateSlackBlockKitBlocks(normalizeSlackBlockKitBlocks(view.blocks), { enforceMessageLimit: false });
    return { target, view };
  }

  const message = normalizeSlackBlockKitMessageObject(raw);
  const blocks = normalizeSlackBlockKitBlocks(message.blocks);
  validateSlackBlockKitMessage({
    text: stringField(message, "text") || "Ravi Slack Block Kit message",
    blocks,
  });
  return { target, message: { ...message, blocks } };
}

export function buildSlackBlockKitShowcasePayload(): SlackBlockKitMessagePayload {
  return {
    text: "Ravi Slack Block Kit showcase",
    blocks: [
      {
        type: "header",
        block_id: "ravi_blockkit_header",
        text: {
          type: "plain_text",
          text: "Ravi Block Kit native showcase",
          emoji: true,
        },
      },
      {
        type: "section",
        block_id: "ravi_blockkit_intro",
        text: {
          type: "mrkdwn",
          text: "*Block Kit nativo*: mensagem rica, botoes, selects e eventos roteados como `ravi.inbound.interaction`.",
        },
      },
      {
        type: "section",
        block_id: "ravi_blockkit_matrix",
        fields: [
          { type: "mrkdwn", text: "*Mensagens*\n`chat.postMessage`" },
          { type: "mrkdwn", text: "*Updates*\n`chat.update`" },
          { type: "mrkdwn", text: "*Validacao*\n`blocks.validate`" },
          { type: "mrkdwn", text: "*Interacoes*\nSocket Mode" },
        ],
      },
      {
        type: "actions",
        block_id: "ravi_blockkit_actions",
        elements: [
          {
            type: "button",
            action_id: "ravi_blockkit_approve",
            text: { type: "plain_text", text: "Aprovar", emoji: true },
            style: "primary",
            value: "approve",
          },
          {
            type: "button",
            action_id: "ravi_blockkit_reject",
            text: { type: "plain_text", text: "Rejeitar", emoji: true },
            style: "danger",
            value: "reject",
            confirm: {
              title: { type: "plain_text", text: "Confirmar" },
              text: { type: "mrkdwn", text: "Enviar evento de rejeicao para o Ravi?" },
              confirm: { type: "plain_text", text: "Enviar" },
              deny: { type: "plain_text", text: "Cancelar" },
            },
          },
          {
            type: "static_select",
            action_id: "ravi_blockkit_priority",
            placeholder: { type: "plain_text", text: "Prioridade" },
            options: [
              { text: { type: "plain_text", text: "Baixa" }, value: "low" },
              { text: { type: "plain_text", text: "Media" }, value: "medium" },
              { text: { type: "plain_text", text: "Alta" }, value: "high" },
            ],
          },
        ],
      },
      {
        type: "context",
        block_id: "ravi_blockkit_context",
        elements: [
          {
            type: "mrkdwn",
            text: "Clique em qualquer controle para gerar um evento nativo sem expor token Slack ao agent.",
          },
        ],
      },
    ],
  };
}

export function validateSlackBlockKitMessage(input: SlackBlockKitMessagePayload): void {
  if (!input.text.trim()) {
    throw new Error("Slack Block Kit messages require top-level fallback text");
  }
  validateSlackBlockKitBlocks(input.blocks, { enforceMessageLimit: true });
}

function normalizeSlackBlockKitMessageObject(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return { blocks: raw };
  const record = normalizeSlackBlockKitRecord(raw, "Block Kit message payload");
  if (!Array.isArray(record.blocks)) {
    throw new Error("Block Kit message payload must contain a blocks array");
  }
  return record;
}

function normalizeSlackBlockKitBlocks(raw: unknown): readonly SlackBlockKitBlock[] {
  if (!Array.isArray(raw)) throw new Error("Block Kit payload must contain a blocks array");
  return raw.map((block, index) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new Error(`Block Kit block at index ${index} must be an object`);
    }
    return block as SlackBlockKitBlock;
  });
}

function validateSlackBlockKitBlocks(
  blocks: readonly SlackBlockKitBlock[],
  options: { readonly enforceMessageLimit: boolean },
): void {
  if (blocks.length === 0) throw new Error("Block Kit payload must contain at least one block");
  if (options.enforceMessageLimit && blocks.length > MESSAGE_BLOCK_LIMIT) {
    throw new Error(`Slack messages support at most ${MESSAGE_BLOCK_LIMIT} blocks`);
  }

  for (const [index, block] of blocks.entries()) {
    validateSlackBlock(index, block);
  }
}

function validateSlackBlock(index: number, block: SlackBlockKitBlock): void {
  const type = stringField(block, "type");
  if (!type) throw new Error(`Block Kit block at index ${index} is missing type`);
  validateSlackIdentifier(block.block_id, `blocks[${index}].block_id`);

  if (type === "actions") {
    const elements = Array.isArray(block.elements) ? block.elements : [];
    if (elements.length === 0) throw new Error(`Actions block at index ${index} must contain elements`);
    if (elements.length > ACTIONS_ELEMENTS_LIMIT) {
      throw new Error(`Actions block at index ${index} supports at most ${ACTIONS_ELEMENTS_LIMIT} elements`);
    }
  }

  validateInteractiveElements(block, `blocks[${index}]`);
}

function validateInteractiveElements(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) validateInteractiveElements(item, `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const type = stringField(record, "type");
  if (type && INTERACTIVE_ELEMENT_TYPES_REQUIRING_ACTION_ID.has(type)) {
    if (!stringField(record, "action_id")) throw new Error(`${path}.action_id is required for ${type}`);
  }
  validateSlackIdentifier(record.action_id, `${path}.action_id`);
  validateSlackIdentifier(record.block_id, `${path}.block_id`);

  for (const [key, item] of Object.entries(record)) {
    if (key === "confirm") continue;
    if (item && typeof item === "object") validateInteractiveElements(item, `${path}.${key}`);
  }
}

function parseSlackBlockKitValidationTarget(value: string | undefined): SlackBlockKitValidationTarget {
  const target = value?.trim() || "message";
  if (target === "blocks" || target === "message" || target === "view") return target;
  throw new Error("Invalid Block Kit validation target. Expected one of blocks, message or view");
}

function validateSlackIdentifier(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  if (value.length > SLACK_ID_LIMIT) throw new Error(`${path} must be at most ${SLACK_ID_LIMIT} characters`);
}

function normalizeSlackBlockKitRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  return raw as Record<string, unknown>;
}

function recordField(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>)[key];
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
