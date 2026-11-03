// Bases v1 limits. See `.ravi/specs/console/bases/SPEC.md` "Limits (v1)".

export const BASES_LIMITS = {
  basesPerProject: 200,
  rowsPerBase: 100_000,
  propertiesPerBase: 100,
  viewsPerBase: 50,
  chartsPerBase: 50,
  optionsPerProperty: 200,
  multiSelectValues: 100,
  personValues: 50,
  refValues: 50,
  textBytes: 16 * 1024,
  bodyBytes: 256 * 1024,
  rowValuesBytes: 256 * 1024,
  requestBodyBytes: 1024 * 1024,
  batchRows: 500,
  bulkEventThreshold: 50,
  filterDepth: 8,
  filterLeaves: 64,
  filterChildren: 32,
  sortKeys: 3,
  groupByDimensions: 2,
  aggregateMeasures: 8,
  aggregateGroups: 5_000,
  aggregateMinGroupSize: 5,
  queryLimitDefault: 100,
  queryLimitMax: 500,
  queryTimeoutMs: 5_000,
  aggregateTimeoutMs: 10_000,
  cursorTtlMs: 15 * 60 * 1000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  migrationRowsMax: 10_000,
  durationMax: 1000,
  urlChars: 2048,
  emailChars: 320,
  nameChars: 120,
  descriptionChars: 2000,
  viewColumns: 120,
  historyLimitDefault: 50,
  historyLimitMax: 200,
  searchChars: 200,
  approversPerProperty: 20,
  approvalNoteChars: 1000,
  agentInstructionsChars: 4000,
  agentInputs: 20,
  agentLabelChars: 64,
  agentErrorChars: 1000,
  subscriptionProperties: 20,
  activityPageSize: 50,
} as const;

export const BASE_PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const BASE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const BASE_DURATION_PATTERN = /^([1-9][0-9]{0,3})(d|w|mo|y)$/;
export const BASE_PHONE_PATTERN = /^[+0-9 ()./-]{3,40}$/;
export const BASE_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const BASE_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
