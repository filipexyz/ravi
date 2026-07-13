export const SLACK_NATIVE_WORK_OBJECT_ENTITY_TYPES = [
  "slack#/entities/file",
  "slack#/entities/task",
  "slack#/entities/incident",
  "slack#/entities/content_item",
  "slack#/entities/item",
] as const;

export type SlackNativeWorkObjectEntityType = (typeof SLACK_NATIVE_WORK_OBJECT_ENTITY_TYPES)[number];

export interface SlackNativeWorkObjectMessagePayload {
  readonly text: string;
  readonly metadata: Record<string, unknown>;
}

export interface SlackNativeWorkObjectUnfurlPayload {
  readonly metadata?: Record<string, unknown>;
  readonly unfurls?: Record<string, unknown>;
}

const SUPPORTED_ENTITY_TYPES = new Set<string>(SLACK_NATIVE_WORK_OBJECT_ENTITY_TYPES);

export function normalizeSlackNativeWorkObjectMetadata(input: unknown): Record<string, unknown> {
  const metadata = unwrapMetadataEnvelope(input);
  const entities = metadata.entities;
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error("Slack Work Object metadata must include a non-empty entities array");
  }
  entities.forEach((entity, index) => {
    validateSlackNativeWorkObjectEntity(entity, `entities[${index}]`);
  });
  return metadata;
}

export function normalizeSlackNativeWorkObjectDetailMetadata(input: unknown): Record<string, unknown> {
  const metadata = unwrapMetadataEnvelope(input);
  if (Array.isArray(metadata.entities)) {
    if (metadata.entities.length !== 1) {
      throw new Error("Slack Work Object detail metadata must include exactly one entity");
    }
    const entity = assertRecord(metadata.entities[0], "entities[0]");
    validateSlackNativeWorkObjectEntity(entity, "entities[0]", { allowAppUnfurlUrl: true });
    return withoutKey(entity, "app_unfurl_url");
  }
  validateSlackNativeWorkObjectEntity(metadata, "metadata", { allowAppUnfurlUrl: true });
  return withoutKey(metadata, "app_unfurl_url");
}

export function normalizeSlackNativeWorkObjectMessagePayload(
  input: unknown,
  textOverride?: string,
): SlackNativeWorkObjectMessagePayload {
  const record = assertRecord(input, "Slack Work Object message payload");
  const metadata = normalizeSlackNativeWorkObjectMetadata(record);
  const text = textOverride?.trim() || stringValue(record.text)?.trim() || titleTextFromMetadata(metadata);
  if (!text) {
    throw new Error("Slack Work Object message payload must include top-level text or metadata title text");
  }
  return { text, metadata };
}

export function normalizeSlackNativeWorkObjectUnfurlPayload(
  input: unknown,
  appUnfurlUrl?: string,
): SlackNativeWorkObjectUnfurlPayload {
  const record = assertRecord(input, "Slack Work Object unfurl payload");
  const metadataInput = record.metadata ?? record;
  const unfurls = record.unfurls === undefined ? undefined : assertRecord(record.unfurls, "unfurls");
  const metadata = normalizeSlackNativeWorkObjectMetadata(metadataInput);
  const normalizedMetadata = appUnfurlUrl?.trim() ? withDefaultAppUnfurlUrl(metadata, appUnfurlUrl.trim()) : metadata;
  return { metadata: normalizedMetadata, ...(unfurls ? { unfurls } : {}) };
}

function validateSlackNativeWorkObjectEntity(
  input: unknown,
  path: string,
  options: { readonly allowAppUnfurlUrl?: boolean } = {},
): void {
  const entity = assertRecord(input, path);
  const entityType = requiredString(entity, "entity_type", path);
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) {
    throw new Error(
      `${path}.entity_type must be one of ${SLACK_NATIVE_WORK_OBJECT_ENTITY_TYPES.join(", ")}; received ${entityType}`,
    );
  }
  requiredString(entity, "url", path);
  if (!options.allowAppUnfurlUrl && "app_unfurl_url" in entity) {
    optionalString(entity, "app_unfurl_url", path);
  }
  const externalRef = assertRecord(entity.external_ref, `${path}.external_ref`);
  requiredString(externalRef, "id", `${path}.external_ref`);
  optionalString(externalRef, "type", `${path}.external_ref`);

  const payload = assertRecord(entity.entity_payload, `${path}.entity_payload`);
  const attributes = assertRecord(payload.attributes, `${path}.entity_payload.attributes`);
  const title = assertRecord(attributes.title, `${path}.entity_payload.attributes.title`);
  requiredString(title, "text", `${path}.entity_payload.attributes.title`);
  optionalString(attributes, "display_type", `${path}.entity_payload.attributes`);
  optionalString(attributes, "product_name", `${path}.entity_payload.attributes`);
  optionalNumber(attributes, "metadata_last_modified", `${path}.entity_payload.attributes`);

  if (payload.fields !== undefined) assertRecord(payload.fields, `${path}.entity_payload.fields`);
  if (payload.custom_fields !== undefined && !Array.isArray(payload.custom_fields)) {
    throw new Error(`${path}.entity_payload.custom_fields must be an array when provided`);
  }
  if (payload.display_order !== undefined) {
    const order = payload.display_order;
    if (!Array.isArray(order) || order.some((item) => typeof item !== "string")) {
      throw new Error(`${path}.entity_payload.display_order must be an array of strings when provided`);
    }
  }
}

function unwrapMetadataEnvelope(input: unknown): Record<string, unknown> {
  const record = assertRecord(input, "Slack Work Object metadata");
  if (record.metadata !== undefined) return assertRecord(record.metadata, "metadata");
  return record;
}

function withDefaultAppUnfurlUrl(metadata: Record<string, unknown>, appUnfurlUrl: string): Record<string, unknown> {
  const entities = Array.isArray(metadata.entities) ? metadata.entities : [];
  return {
    ...metadata,
    entities: entities.map((entity) => {
      const record = assertRecord(entity, "entity");
      return {
        app_unfurl_url: appUnfurlUrl,
        ...record,
      };
    }),
  };
}

function titleTextFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const entities = Array.isArray(metadata.entities) ? metadata.entities : [];
  const first = assertRecord(entities[0], "entities[0]");
  const payload = assertRecord(first.entity_payload, "entities[0].entity_payload");
  const attributes = assertRecord(payload.attributes, "entities[0].entity_payload.attributes");
  const title = assertRecord(attributes.title, "entities[0].entity_payload.attributes.title");
  return stringValue(title.text);
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = stringValue(record[key])?.trim();
  if (!value) throw new Error(`${path}.${key} is required`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    throw new Error(`${path}.${key} must be a string when provided`);
  }
}

function optionalNumber(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined && typeof record[key] !== "number") {
    throw new Error(`${path}.${key} must be a number when provided`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
