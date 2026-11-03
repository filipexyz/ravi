export type BugDossierChip = {
  key: string;
  label: string;
  value: string;
};

export type BugDossierReproduction = {
  steps: string[];
  expected: string | null;
  actual: string | null;
  frequency: string | null;
};

export type BugDossierEvidence = {
  logs: string[];
  notes: string[];
  redactions: string[];
};

export type BugDossierContext = {
  organizationRef: string | null;
  projectRef: string | null;
  sessionHints: string | null;
};

export type BugDossierExtra = {
  key: string;
  label: string;
  kind: "text" | "list" | "json";
  text?: string;
  items?: string[];
  json?: string;
};

export type BugDossierView = {
  problem: string | null;
  source: string | null;
  tags: string[];
  environment: BugDossierChip[];
  reproduction: BugDossierReproduction | null;
  evidence: BugDossierEvidence | null;
  context: BugDossierContext | null;
  sanitization: string[];
  extras: BugDossierExtra[];
};

const IDENTITY_KEYS = new Set([
  "schemaVersion",
  "title",
  "summary",
  "severity",
  "surface",
  "organizationId",
  "projectId",
]);

const CONSUMED_ROOT_KEYS = new Set([
  ...IDENTITY_KEYS,
  "payload",
  "problem",
  "description",
  "source",
  "tag",
  "note",
  "notes",
  "reproduction",
  "steps",
  "expected",
  "actual",
  "frequency",
  "environment",
  "os",
  "runtime",
  "raviVersion",
  "agentNames",
  "evidence",
  "logs",
  "redactions",
  "context",
  "organizationRef",
  "projectRef",
  "sessionHints",
  "sanitization",
  "rulesApplied",
]);

const ENVIRONMENT_LABELS: Record<string, string> = {
  os: "OS",
  runtime: "Runtime",
  raviVersion: "Ravi",
};

export function unwrapBugDossierRecord(stored: unknown): Record<string, unknown> {
  const root = asRecord(stored);
  if (!root) return {};
  const nested = asRecord(root.payload);
  const looksLikeStoredWrapper =
    Boolean(nested) &&
    ("payload" in root) &&
    ("schemaVersion" in root || "title" in root || "summary" in root || "severity" in root);
  return looksLikeStoredWrapper && nested ? nested : root;
}

export function projectBugDossierView(
  stored: unknown,
  options: { headerSummary?: string | null } = {},
): BugDossierView {
  const root = unwrapBugDossierRecord(stored);
  const reproductionRecord = asRecord(root.reproduction);
  const environmentRecord = asRecord(root.environment);
  const evidenceRecord = asRecord(root.evidence);
  const contextRecord = asRecord(root.context);
  const sanitizationRecord = asRecord(root.sanitization);

  const nestedSummary = textValue(root.summary);
  const headerSummary = textValue(options.headerSummary);
  const problem =
    textValue(root.problem) ??
    textValue(root.description) ??
    (nestedSummary && nestedSummary !== headerSummary ? nestedSummary : null);

  const source = textValue(root.source);
  const tags = uniqueTexts([textValue(root.tag)]);

  const environment = collectEnvironmentChips(root, environmentRecord);
  const reproduction = collectReproduction(root, reproductionRecord);
  const evidence = collectEvidence(root, evidenceRecord);
  const context = collectContext(root, contextRecord);
  const sanitization = uniqueTexts([
    ...stringList(sanitizationRecord?.rulesApplied),
    ...stringList(root.rulesApplied),
  ]);

  const extras = collectExtras(root, {
    environmentRecord,
    evidenceRecord,
    contextRecord,
    reproductionRecord,
    sanitizationRecord,
  });

  return {
    problem,
    source,
    tags,
    environment,
    reproduction,
    evidence,
    context,
    sanitization,
    extras,
  };
}

export function bugDossierHasContent(view: BugDossierView): boolean {
  return Boolean(
    view.problem ||
      view.source ||
      view.tags.length > 0 ||
      view.environment.length > 0 ||
      view.reproduction ||
      view.evidence ||
      view.context ||
      view.sanitization.length > 0 ||
      view.extras.length > 0,
  );
}

export function bugDossierHasKnownSections(view: BugDossierView): boolean {
  return Boolean(
    view.problem ||
      view.source ||
      view.tags.length > 0 ||
      view.environment.length > 0 ||
      view.reproduction ||
      view.evidence ||
      view.context ||
      view.sanitization.length > 0,
  );
}

function collectEnvironmentChips(
  root: Record<string, unknown>,
  environment: Record<string, unknown> | null,
): BugDossierChip[] {
  const chips: BugDossierChip[] = [];
  const values = {
    os: textValue(environment?.os) ?? textValue(root.os),
    runtime: textValue(environment?.runtime) ?? textValue(root.runtime),
    raviVersion: textValue(environment?.raviVersion) ?? textValue(root.raviVersion),
  };

  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    chips.push({
      key,
      label: ENVIRONMENT_LABELS[key] ?? humanizeKey(key),
      value,
    });
  }

  const agents = uniqueTexts([
    ...stringList(environment?.agentNames),
    ...stringList(root.agentNames),
  ]);
  for (const [index, agent] of agents.entries()) {
    chips.push({
      key: `agentNames.${index}`,
      label: "Agent",
      value: agent,
    });
  }

  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (key === "os" || key === "runtime" || key === "raviVersion" || key === "agentNames") continue;
      pushUnknownChips(chips, key, value);
    }
  }

  return chips;
}

function collectReproduction(
  root: Record<string, unknown>,
  reproduction: Record<string, unknown> | null,
): BugDossierReproduction | null {
  const steps = reproduction?.steps !== undefined ? asSteps(reproduction.steps) : asSteps(root.steps);
  const expected = textValue(reproduction?.expected) ?? textValue(root.expected);
  const actual = textValue(reproduction?.actual) ?? textValue(root.actual);
  const frequency = textValue(reproduction?.frequency) ?? textValue(root.frequency);
  if (steps.length === 0 && !expected && !actual && !frequency) return null;
  return { steps, expected, actual, frequency };
}

function collectEvidence(
  root: Record<string, unknown>,
  evidence: Record<string, unknown> | null,
): BugDossierEvidence | null {
  const logs = evidence?.logs !== undefined ? textList(evidence.logs) : textList(root.logs);
  const notes = uniqueTexts([
    ...stringList(evidence?.notes),
    ...stringList(root.notes),
    ...asOptionalSingleton(root.note),
  ]);
  const redactions = uniqueTexts([
    ...stringList(evidence?.redactions),
    ...stringList(root.redactions),
  ]);
  if (logs.length === 0 && notes.length === 0 && redactions.length === 0) return null;
  return { logs, notes, redactions };
}

function collectContext(
  root: Record<string, unknown>,
  context: Record<string, unknown> | null,
): BugDossierContext | null {
  const organizationRef = textValue(context?.organizationRef) ?? textValue(root.organizationRef);
  const projectRef = textValue(context?.projectRef) ?? textValue(root.projectRef);
  const sessionHints = textValue(context?.sessionHints) ?? textValue(root.sessionHints);
  if (!organizationRef && !projectRef && !sessionHints) return null;
  return { organizationRef, projectRef, sessionHints };
}

function collectExtras(
  root: Record<string, unknown>,
  nested: {
    environmentRecord: Record<string, unknown> | null;
    evidenceRecord: Record<string, unknown> | null;
    contextRecord: Record<string, unknown> | null;
    reproductionRecord: Record<string, unknown> | null;
    sanitizationRecord: Record<string, unknown> | null;
  },
): BugDossierExtra[] {
  const extras: BugDossierExtra[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (CONSUMED_ROOT_KEYS.has(key)) continue;
    pushExtra(extras, key, value);
  }

  pushNestedExtras(extras, "reproduction", nested.reproductionRecord, [
    "steps",
    "expected",
    "actual",
    "frequency",
  ]);
  pushNestedExtras(extras, "evidence", nested.evidenceRecord, ["logs", "notes", "redactions"]);
  pushNestedExtras(extras, "context", nested.contextRecord, [
    "organizationRef",
    "projectRef",
    "sessionHints",
  ]);
  pushNestedExtras(extras, "sanitization", nested.sanitizationRecord, ["rulesApplied"]);
  pushEnvironmentObjectExtras(extras, nested.environmentRecord);
  return extras;
}

function pushEnvironmentObjectExtras(extras: BugDossierExtra[], environment: Record<string, unknown> | null) {
  if (!environment) return;
  for (const [key, value] of Object.entries(environment)) {
    if (key === "os" || key === "runtime" || key === "raviVersion" || key === "agentNames") continue;
    if (textValue(value) || (Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      continue;
    }
    pushExtra(extras, `environment.${key}`, value);
  }
}

function pushNestedExtras(
  extras: BugDossierExtra[],
  prefix: string,
  record: Record<string, unknown> | null,
  consumed: string[],
) {
  if (!record) return;
  const skip = new Set(consumed);
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key)) continue;
    pushExtra(extras, `${prefix}.${key}`, value);
  }
}

function pushUnknownChips(chips: BugDossierChip[], key: string, value: unknown) {
  const text = textValue(value);
  if (text) {
    chips.push({ key, label: humanizeKey(key), value: text });
    return;
  }
  const items = stringList(value);
  for (const [index, item] of items.entries()) {
    chips.push({
      key: `${key}.${index}`,
      label: humanizeKey(key),
      value: item,
    });
  }
}

function pushExtra(extras: BugDossierExtra[], key: string, value: unknown) {
  if (isEmptyValue(value)) return;
  const text = textValue(value);
  if (text) {
    extras.push({ key, label: humanizeKey(key), kind: "text", text });
    return;
  }
  const items = stringList(value);
  if (items.length > 0 && Array.isArray(value) && value.every((item) => typeof item === "string")) {
    extras.push({ key, label: humanizeKey(key), kind: "list", items });
    return;
  }
  extras.push({
    key,
    label: humanizeKey(key),
    kind: "json",
    json: stableJson(value),
  });
}

function asSteps(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item)).filter((item): item is string => Boolean(item));
  }
  const text = textValue(value);
  if (!text) return [];
  if (text.includes("\n")) {
    return text.split(/\n+/).map(stripStepPrefix).filter(Boolean);
  }
  if (/\d+[.)]\s+\S/.test(text) && /\s+\d+[.)]\s+/.test(text)) {
    return text.split(/\s+(?=\d+[.)]\s+)/).map(stripStepPrefix).filter(Boolean);
  }
  return [text];
}

function stripStepPrefix(value: string) {
  return value.replace(/^\s*\d+[.)]\s+/, "").trim();
}

function asOptionalSingleton(value: unknown): string[] {
  const text = textValue(value);
  return text ? [text] : [];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueTexts(value.map((item) => textValue(item)));
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => textValue(item)).filter((item): item is string => Boolean(item));
}

function uniqueTexts(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    items.push(value);
  }
  return items;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isEmptyValue(value: unknown, depth = 0): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (Array.isArray(value)) {
    return value.length === 0 || (depth < 6 && value.every((item) => isEmptyValue(item, depth + 1)));
  }
  const record = asRecord(value);
  if (!record) return false;
  const entries = Object.entries(record);
  return entries.length === 0 || (depth < 6 && entries.every(([, item]) => isEmptyValue(item, depth + 1)));
}

function humanizeKey(key: string) {
  return key
    .split(".")
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/^\w/, (letter) => letter.toUpperCase()),
    )
    .join(" · ");
}

function stableJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
