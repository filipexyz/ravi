// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).

/** Input shape for `adapters.list`. */
export type AdaptersListInput = {
  session?: string;
  status?: string;
};

/** Return shape for `adapters.list`. (no @Returns declared) */
export type AdaptersListReturn = unknown;

/** Input shape for `adapters.show`. */
export type AdaptersShowInput = {
  adapterId: string;
};

/** Return shape for `adapters.show`. (no @Returns declared) */
export type AdaptersShowReturn = unknown;

/** Input shape for `agents.create`. */
export type AgentsCreateInput = {
  allowRuntimeMismatch?: boolean;
  cwd: string;
  id: string;
  provider?: string;
};

/** Return shape for `agents.create`. (no @Returns declared) */
export type AgentsCreateReturn = unknown;

/** Input shape for `agents.debounce`. */
export type AgentsDebounceInput = {
  id: string;
  ms?: string;
};

/** Return shape for `agents.debounce`. (no @Returns declared) */
export type AgentsDebounceReturn = unknown;

/** Input shape for `agents.debug`. */
export type AgentsDebugInput = {
  id: string;
  nameOrKey?: string;
  turns?: string;
};

/** Return shape for `agents.debug`. (no @Returns declared) */
export type AgentsDebugReturn = unknown;

/** Input shape for `agents.delete`. */
export type AgentsDeleteInput = {
  id: string;
};

/** Return shape for `agents.delete`. (no @Returns declared) */
export type AgentsDeleteReturn = unknown;

/** Input shape for `agents.list`. */
export type AgentsListInput = Record<string, never>;

/** Return shape for `agents.list`. (no @Returns declared) */
export type AgentsListReturn = unknown;

/** Input shape for `agents.reset`. */
export type AgentsResetInput = {
  id: string;
  nameOrKey?: string;
};

/** Return shape for `agents.reset`. (no @Returns declared) */
export type AgentsResetReturn = unknown;

/** Input shape for `agents.session`. */
export type AgentsSessionInput = {
  id: string;
};

/** Return shape for `agents.session`. (no @Returns declared) */
export type AgentsSessionReturn = unknown;

/** Input shape for `agents.set`. */
export type AgentsSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `agents.set`. (no @Returns declared) */
export type AgentsSetReturn = unknown;

/** Input shape for `agents.show`. */
export type AgentsShowInput = {
  id: string;
};

/** Return shape for `agents.show`. (no @Returns declared) */
export type AgentsShowReturn = unknown;

/** Input shape for `agents.spec-mode`. */
export type AgentsSpecModeInput = {
  enabled?: string;
  id: string;
};

/** Return shape for `agents.spec-mode`. (no @Returns declared) */
export type AgentsSpecModeReturn = unknown;

/** Input shape for `agents.sync-instructions`. */
export type AgentsSyncInstructionsInput = {
  agent?: string;
  materializeMissing?: boolean;
};

/** Return shape for `agents.sync-instructions`. (no @Returns declared) */
export type AgentsSyncInstructionsReturn = unknown;

/** Input shape for `artifacts.archive`. */
export type ArtifactsArchiveInput = {
  id: string;
};

/** Return shape for `artifacts.archive`. (no @Returns declared) */
export type ArtifactsArchiveReturn = unknown;

/** Input shape for `artifacts.attach`. */
export type ArtifactsAttachInput = {
  id: string;
  metadata?: string;
  relation?: string;
  targetId: string;
  targetType: string;
};

/** Return shape for `artifacts.attach`. (no @Returns declared) */
export type ArtifactsAttachReturn = unknown;

/** Input shape for `artifacts.create`. */
export type ArtifactsCreateInput = {
  command?: string;
  costUsd?: string;
  durationMs?: string;
  input?: string;
  inputTokens?: string;
  kind: string;
  lineage?: string;
  message?: string;
  metadata?: string;
  metrics?: string;
  mime?: string;
  model?: string;
  output?: string;
  outputTokens?: string;
  path?: string;
  prompt?: string;
  provider?: string;
  session?: string;
  summary?: string;
  tags?: string;
  task?: string;
  title?: string;
  totalTokens?: string;
  uri?: string;
};

/** Return shape for `artifacts.create`. (no @Returns declared) */
export type ArtifactsCreateReturn = unknown;

/** Input shape for `artifacts.event`. */
export type ArtifactsEventInput = {
  eventType: string;
  id: string;
  message?: string;
  payload?: string;
  source?: string;
  status?: string;
};

/** Return shape for `artifacts.event`. (no @Returns declared) */
export type ArtifactsEventReturn = unknown;

/** Input shape for `artifacts.events`. */
export type ArtifactsEventsInput = {
  id: string;
};

/** Return shape for `artifacts.events`. (no @Returns declared) */
export type ArtifactsEventsReturn = unknown;

/** Input shape for `artifacts.list`. */
export type ArtifactsListInput = {
  includeDeleted?: boolean;
  kind?: string;
  limit?: string;
  session?: string;
  tag?: string;
  task?: string;
};

/** Return shape for `artifacts.list`. (no @Returns declared) */
export type ArtifactsListReturn = unknown;

/** Input shape for `artifacts.show`. */
export type ArtifactsShowInput = {
  id: string;
};

/** Return shape for `artifacts.show`. (no @Returns declared) */
export type ArtifactsShowReturn = unknown;

/** Input shape for `artifacts.update`. */
export type ArtifactsUpdateInput = {
  command?: string;
  costUsd?: string;
  durationMs?: string;
  id: string;
  input?: string;
  inputTokens?: string;
  lineage?: string;
  message?: string;
  metadata?: string;
  metrics?: string;
  mime?: string;
  model?: string;
  output?: string;
  outputTokens?: string;
  path?: string;
  prompt?: string;
  provider?: string;
  session?: string;
  status?: string;
  summary?: string;
  tags?: string;
  task?: string;
  title?: string;
  totalTokens?: string;
  uri?: string;
};

/** Return shape for `artifacts.update`. (no @Returns declared) */
export type ArtifactsUpdateReturn = unknown;

/** Input shape for `artifacts.watch`. */
export type ArtifactsWatchInput = {
  id: string;
  intervalMs?: string;
  timeoutMs?: string;
};

/** Return shape for `artifacts.watch`. (no @Returns declared) */
export type ArtifactsWatchReturn = unknown;

/** Input shape for `audio.generate`. */
export type AudioGenerateInput = {
  caption?: string;
  format?: string;
  lang?: string;
  model?: string;
  output?: string;
  send?: boolean;
  speed?: string;
  text: string;
  voice?: string;
};

/** Return shape for `audio.generate`. (no @Returns declared) */
export type AudioGenerateReturn = unknown;

/** Input shape for `contacts.add`. */
export type ContactsAddInput = {
  agent?: string;
  identity: string;
  kind?: string;
  name?: string;
};

/** Return shape for `contacts.add`. (no @Returns declared) */
export type ContactsAddReturn = unknown;

/** Input shape for `contacts.allow`. */
export type ContactsAllowInput = {
  contact: string;
};

/** Return shape for `contacts.allow`. (no @Returns declared) */
export type ContactsAllowReturn = unknown;

/** Input shape for `contacts.approve`. */
export type ContactsApproveInput = {
  agent?: string;
  contact: string;
  mode?: string;
};

/** Return shape for `contacts.approve`. (no @Returns declared) */
export type ContactsApproveReturn = unknown;

/** Input shape for `contacts.block`. */
export type ContactsBlockInput = {
  contact: string;
};

/** Return shape for `contacts.block`. (no @Returns declared) */
export type ContactsBlockReturn = unknown;

/** Input shape for `contacts.check`. */
export type ContactsCheckInput = {
  contact: string;
};

/** Return shape for `contacts.check`. (no @Returns declared) */
export type ContactsCheckReturn = unknown;

/** Input shape for `contacts.duplicates`. */
export type ContactsDuplicatesInput = Record<string, never>;

/** Return shape for `contacts.duplicates`. (no @Returns declared) */
export type ContactsDuplicatesReturn = unknown;

/** Input shape for `contacts.find`. */
export type ContactsFindInput = {
  query: string;
  tag?: boolean;
};

/** Return shape for `contacts.find`. (no @Returns declared) */
export type ContactsFindReturn = unknown;

/** Input shape for `contacts.get`. */
export type ContactsGetInput = {
  contact: string;
};

/** Return shape for `contacts.get`. (no @Returns declared) */
export type ContactsGetReturn = unknown;

/** Input shape for `contacts.group-tag`. */
export type ContactsGroupTagInput = {
  contact: string;
  group: string;
  tag: string;
};

/** Return shape for `contacts.group-tag`. (no @Returns declared) */
export type ContactsGroupTagReturn = unknown;

/** Input shape for `contacts.group-untag`. */
export type ContactsGroupUntagInput = {
  contact: string;
  group: string;
};

/** Return shape for `contacts.group-untag`. (no @Returns declared) */
export type ContactsGroupUntagReturn = unknown;

/** Input shape for `contacts.identity-add`. */
export type ContactsIdentityAddInput = {
  contact: string;
  platform: string;
  value: string;
};

/** Return shape for `contacts.identity-add`. (no @Returns declared) */
export type ContactsIdentityAddReturn = unknown;

/** Input shape for `contacts.identity-remove`. */
export type ContactsIdentityRemoveInput = {
  platform: string;
  value: string;
};

/** Return shape for `contacts.identity-remove`. (no @Returns declared) */
export type ContactsIdentityRemoveReturn = unknown;

/** Input shape for `contacts.info`. */
export type ContactsInfoInput = {
  contact: string;
};

/** Return shape for `contacts.info`. (no @Returns declared) */
export type ContactsInfoReturn = unknown;

/** Input shape for `contacts.link`. */
export type ContactsLinkInput = {
  channel?: string;
  contact: string;
  id?: string;
  instance?: string;
  reason?: string;
};

/** Return shape for `contacts.link`. (no @Returns declared) */
export type ContactsLinkReturn = unknown;

/** Input shape for `contacts.list`. */
export type ContactsListInput = {
  status?: string;
};

/** Return shape for `contacts.list`. (no @Returns declared) */
export type ContactsListReturn = unknown;

/** Input shape for `contacts.merge`. */
export type ContactsMergeInput = {
  source: string;
  target: string;
};

/** Return shape for `contacts.merge`. (no @Returns declared) */
export type ContactsMergeReturn = unknown;

/** Input shape for `contacts.pending`. */
export type ContactsPendingInput = {
  account?: string;
};

/** Return shape for `contacts.pending`. (no @Returns declared) */
export type ContactsPendingReturn = unknown;

/** Input shape for `contacts.remove`. */
export type ContactsRemoveInput = {
  contact: string;
};

/** Return shape for `contacts.remove`. (no @Returns declared) */
export type ContactsRemoveReturn = unknown;

/** Input shape for `contacts.set`. */
export type ContactsSetInput = {
  contact: string;
  key: string;
  value: string;
};

/** Return shape for `contacts.set`. (no @Returns declared) */
export type ContactsSetReturn = unknown;

/** Input shape for `contacts.tag`. */
export type ContactsTagInput = {
  contact: string;
  tag: string;
};

/** Return shape for `contacts.tag`. (no @Returns declared) */
export type ContactsTagReturn = unknown;

/** Input shape for `contacts.unlink`. */
export type ContactsUnlinkInput = {
  channel?: string;
  instance?: string;
  platformIdentity: string;
  reason?: string;
};

/** Return shape for `contacts.unlink`. (no @Returns declared) */
export type ContactsUnlinkReturn = unknown;

/** Input shape for `contacts.untag`. */
export type ContactsUntagInput = {
  contact: string;
  tag: string;
};

/** Return shape for `contacts.untag`. (no @Returns declared) */
export type ContactsUntagReturn = unknown;

/** Input shape for `context.authorize`. */
export type ContextAuthorizeInput = {
  objectId: string;
  objectType: string;
  permission: string;
};

/** Return shape for `context.authorize`. (no @Returns declared) */
export type ContextAuthorizeReturn = unknown;

/** Input shape for `context.capabilities`. */
export type ContextCapabilitiesInput = Record<string, never>;

/** Return shape for `context.capabilities`. (no @Returns declared) */
export type ContextCapabilitiesReturn = unknown;

/** Input shape for `context.check`. */
export type ContextCheckInput = {
  objectId: string;
  objectType: string;
  permission: string;
};

/** Return shape for `context.check`. (no @Returns declared) */
export type ContextCheckReturn = unknown;

/** Input shape for `context.codex-bash-hook`. */
export type ContextCodexBashHookInput = Record<string, never>;

/** Return shape for `context.codex-bash-hook`. (no @Returns declared) */
export type ContextCodexBashHookReturn = unknown;

/** Input shape for `context.credentials.add`. */
export type ContextCredentialsAddInput = {
  contextKey: string;
  label?: string;
  setDefault?: boolean;
};

/** Return shape for `context.credentials.add`. (no @Returns declared) */
export type ContextCredentialsAddReturn = unknown;

/** Input shape for `context.credentials.list`. */
export type ContextCredentialsListInput = Record<string, never>;

/** Return shape for `context.credentials.list`. (no @Returns declared) */
export type ContextCredentialsListReturn = unknown;

/** Input shape for `context.credentials.remove`. */
export type ContextCredentialsRemoveInput = {
  contextKey: string;
};

/** Return shape for `context.credentials.remove`. (no @Returns declared) */
export type ContextCredentialsRemoveReturn = unknown;

/** Input shape for `context.credentials.set-default`. */
export type ContextCredentialsSetDefaultInput = {
  contextKey: string;
};

/** Return shape for `context.credentials.set-default`. (no @Returns declared) */
export type ContextCredentialsSetDefaultReturn = unknown;

/** Input shape for `context.info`. */
export type ContextInfoInput = {
  contextId: string;
};

/** Return shape for `context.info`. (no @Returns declared) */
export type ContextInfoReturn = unknown;

/** Input shape for `context.issue`. */
export type ContextIssueInput = {
  allow?: string;
  cliName: string;
  inherit?: boolean;
  ttl?: string;
};

/** Return shape for `context.issue`. (no @Returns declared) */
export type ContextIssueReturn = unknown;

/** Input shape for `context.lineage`. */
export type ContextLineageInput = {
  contextId: string;
};

/** Return shape for `context.lineage`. (no @Returns declared) */
export type ContextLineageReturn = unknown;

/** Input shape for `context.list`. */
export type ContextListInput = {
  agent?: string;
  all?: boolean;
  kind?: string;
  session?: string;
};

/** Return shape for `context.list`. (no @Returns declared) */
export type ContextListReturn = unknown;

/** Input shape for `context.revoke`. */
export type ContextRevokeInput = {
  contextId: string;
  noCascade?: boolean;
  reason?: string;
};

/** Return shape for `context.revoke`. (no @Returns declared) */
export type ContextRevokeReturn = unknown;

/** Input shape for `context.whoami`. */
export type ContextWhoamiInput = Record<string, never>;

/** Return shape for `context.whoami`. (no @Returns declared) */
export type ContextWhoamiReturn = unknown;

/** Input shape for `costs.agent`. */
export type CostsAgentInput = {
  agentId: string;
  hours?: string;
};

/** Return shape for `costs.agent`. (no @Returns declared) */
export type CostsAgentReturn = unknown;

/** Input shape for `costs.agents`. */
export type CostsAgentsInput = {
  hours?: string;
  limit?: string;
};

/** Return shape for `costs.agents`. (no @Returns declared) */
export type CostsAgentsReturn = unknown;

/** Input shape for `costs.session`. */
export type CostsSessionInput = {
  nameOrKey: string;
};

/** Return shape for `costs.session`. (no @Returns declared) */
export type CostsSessionReturn = unknown;

/** Input shape for `costs.summary`. */
export type CostsSummaryInput = {
  hours?: string;
};

/** Return shape for `costs.summary`. (no @Returns declared) */
export type CostsSummaryReturn = unknown;

/** Input shape for `costs.top-sessions`. */
export type CostsTopSessionsInput = {
  hours?: string;
  limit?: string;
};

/** Return shape for `costs.top-sessions`. (no @Returns declared) */
export type CostsTopSessionsReturn = unknown;

/** Input shape for `cron.add`. */
export type CronAddInput = {
  account?: string;
  agent?: string;
  at?: string;
  cron?: string;
  deleteAfter?: boolean;
  description?: string;
  every?: string;
  isolated?: boolean;
  message?: string;
  name: string;
  tz?: string;
};

/** Return shape for `cron.add`. (no @Returns declared) */
export type CronAddReturn = unknown;

/** Input shape for `cron.disable`. */
export type CronDisableInput = {
  id: string;
};

/** Return shape for `cron.disable`. (no @Returns declared) */
export type CronDisableReturn = unknown;

/** Input shape for `cron.enable`. */
export type CronEnableInput = {
  id: string;
};

/** Return shape for `cron.enable`. (no @Returns declared) */
export type CronEnableReturn = unknown;

/** Input shape for `cron.list`. */
export type CronListInput = Record<string, never>;

/** Return shape for `cron.list`. (no @Returns declared) */
export type CronListReturn = unknown;

/** Input shape for `cron.rm`. */
export type CronRmInput = {
  id: string;
};

/** Return shape for `cron.rm`. (no @Returns declared) */
export type CronRmReturn = unknown;

/** Input shape for `cron.run`. */
export type CronRunInput = {
  id: string;
};

/** Return shape for `cron.run`. (no @Returns declared) */
export type CronRunReturn = unknown;

/** Input shape for `cron.set`. */
export type CronSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `cron.set`. (no @Returns declared) */
export type CronSetReturn = unknown;

/** Input shape for `cron.show`. */
export type CronShowInput = {
  id: string;
};

/** Return shape for `cron.show`. (no @Returns declared) */
export type CronShowReturn = unknown;

/** Input shape for `daemon.dev`. */
export type DaemonDevInput = Record<string, never>;

/** Return shape for `daemon.dev`. (no @Returns declared) */
export type DaemonDevReturn = unknown;

/** Input shape for `daemon.env`. */
export type DaemonEnvInput = Record<string, never>;

/** Return shape for `daemon.env`. (no @Returns declared) */
export type DaemonEnvReturn = unknown;

/** Input shape for `daemon.init-admin-key`. */
export type DaemonInitAdminKeyInput = {
  fromEnv?: boolean;
  label?: string;
  noStore?: boolean;
  printOnly?: boolean;
};

/** Return shape for `daemon.init-admin-key`. (no @Returns declared) */
export type DaemonInitAdminKeyReturn = unknown;

/** Input shape for `daemon.install`. */
export type DaemonInstallInput = Record<string, never>;

/** Return shape for `daemon.install`. (no @Returns declared) */
export type DaemonInstallReturn = unknown;

/** Input shape for `daemon.logs`. */
export type DaemonLogsInput = {
  clear?: boolean;
  follow?: boolean;
  path?: boolean;
  tail?: string;
};

/** Return shape for `daemon.logs`. (no @Returns declared) */
export type DaemonLogsReturn = unknown;

/** Input shape for `daemon.restart`. */
export type DaemonRestartInput = {
  build?: boolean;
  message?: string;
};

/** Return shape for `daemon.restart`. (no @Returns declared) */
export type DaemonRestartReturn = unknown;

/** Input shape for `daemon.run`. */
export type DaemonRunInput = Record<string, never>;

/** Return shape for `daemon.run`. (no @Returns declared) */
export type DaemonRunReturn = unknown;

/** Input shape for `daemon.start`. */
export type DaemonStartInput = Record<string, never>;

/** Return shape for `daemon.start`. (no @Returns declared) */
export type DaemonStartReturn = unknown;

/** Input shape for `daemon.status`. */
export type DaemonStatusInput = Record<string, never>;

/** Return shape for `daemon.status`. (no @Returns declared) */
export type DaemonStatusReturn = unknown;

/** Input shape for `daemon.stop`. */
export type DaemonStopInput = Record<string, never>;

/** Return shape for `daemon.stop`. (no @Returns declared) */
export type DaemonStopReturn = unknown;

/** Input shape for `daemon.uninstall`. */
export type DaemonUninstallInput = Record<string, never>;

/** Return shape for `daemon.uninstall`. (no @Returns declared) */
export type DaemonUninstallReturn = unknown;

/** Input shape for `devin.auth.check`. */
export type DevinAuthCheckInput = Record<string, never>;

/** Return shape for `devin.auth.check`. (no @Returns declared) */
export type DevinAuthCheckReturn = unknown;

/** Input shape for `devin.sessions.archive`. */
export type DevinSessionsArchiveInput = {
  session: string;
};

/** Return shape for `devin.sessions.archive`. (no @Returns declared) */
export type DevinSessionsArchiveReturn = unknown;

/** Input shape for `devin.sessions.attachments`. */
export type DevinSessionsAttachmentsInput = {
  cached?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.attachments`. (no @Returns declared) */
export type DevinSessionsAttachmentsReturn = unknown;

/** Input shape for `devin.sessions.create`. */
export type DevinSessionsCreateInput = {
  advancedMode?: string;
  asUser?: string;
  attachmentUrl?: string[];
  bypassApproval?: boolean;
  childPlaybook?: string;
  knowledge?: string[];
  maxAcu?: string;
  noMaxAcuLimit?: boolean;
  playbook?: string;
  project?: string;
  prompt?: string;
  promptFile?: string;
  proxRun?: string;
  repo?: string[];
  secret?: string[];
  sessionLink?: string[];
  structuredOutputSchema?: string;
  tag?: string[];
  task?: string;
  title?: string;
};

/** Return shape for `devin.sessions.create`. (no @Returns declared) */
export type DevinSessionsCreateReturn = unknown;

/** Input shape for `devin.sessions.insights`. */
export type DevinSessionsInsightsInput = {
  generate?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.insights`. (no @Returns declared) */
export type DevinSessionsInsightsReturn = unknown;

/** Input shape for `devin.sessions.list`. */
export type DevinSessionsListInput = {
  limit?: string;
  remote?: boolean;
  status?: string;
  tag?: string;
};

/** Return shape for `devin.sessions.list`. (no @Returns declared) */
export type DevinSessionsListReturn = unknown;

/** Input shape for `devin.sessions.messages`. */
export type DevinSessionsMessagesInput = {
  cached?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.messages`. (no @Returns declared) */
export type DevinSessionsMessagesReturn = unknown;

/** Input shape for `devin.sessions.send`. */
export type DevinSessionsSendInput = {
  asUser?: string;
  message: string;
  session: string;
};

/** Return shape for `devin.sessions.send`. (no @Returns declared) */
export type DevinSessionsSendReturn = unknown;

/** Input shape for `devin.sessions.show`. */
export type DevinSessionsShowInput = {
  session: string;
  sync?: boolean;
};

/** Return shape for `devin.sessions.show`. (no @Returns declared) */
export type DevinSessionsShowReturn = unknown;

/** Input shape for `devin.sessions.sync`. */
export type DevinSessionsSyncInput = {
  artifacts?: boolean;
  insights?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.sync`. (no @Returns declared) */
export type DevinSessionsSyncReturn = unknown;

/** Input shape for `devin.sessions.terminate`. */
export type DevinSessionsTerminateInput = {
  archive?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.terminate`. (no @Returns declared) */
export type DevinSessionsTerminateReturn = unknown;

/** Input shape for `eval.run`. */
export type EvalRunInput = {
  output?: string;
  specPath: string;
};

/** Return shape for `eval.run`. (no @Returns declared) */
export type EvalRunReturn = unknown;

/** Input shape for `events.replay`. */
export type EventsReplayInput = {
  agent?: string;
  chat?: string;
  contains?: string;
  limit?: string;
  raw?: boolean;
  scan?: string;
  session?: string;
  since?: string;
  stream?: string;
  subject?: string;
  type?: string;
  until?: string;
  where?: string;
};

/** Return shape for `events.replay`. (no @Returns declared) */
export type EventsReplayReturn = unknown;

/** Input shape for `events.stream`. */
export type EventsStreamInput = {
  filter?: string;
  noClaude?: boolean;
  noHeartbeat?: boolean;
  only?: string;
};

/** Return shape for `events.stream`. (no @Returns declared) */
export type EventsStreamReturn = unknown;

/** Input shape for `heartbeat.disable`. */
export type HeartbeatDisableInput = {
  id: string;
};

/** Return shape for `heartbeat.disable`. (no @Returns declared) */
export type HeartbeatDisableReturn = unknown;

/** Input shape for `heartbeat.enable`. */
export type HeartbeatEnableInput = {
  id: string;
  interval?: string;
};

/** Return shape for `heartbeat.enable`. (no @Returns declared) */
export type HeartbeatEnableReturn = unknown;

/** Input shape for `heartbeat.set`. */
export type HeartbeatSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `heartbeat.set`. (no @Returns declared) */
export type HeartbeatSetReturn = unknown;

/** Input shape for `heartbeat.show`. */
export type HeartbeatShowInput = {
  id: string;
};

/** Return shape for `heartbeat.show`. (no @Returns declared) */
export type HeartbeatShowReturn = unknown;

/** Input shape for `heartbeat.status`. */
export type HeartbeatStatusInput = Record<string, never>;

/** Return shape for `heartbeat.status`. (no @Returns declared) */
export type HeartbeatStatusReturn = unknown;

/** Input shape for `heartbeat.trigger`. */
export type HeartbeatTriggerInput = {
  id: string;
};

/** Return shape for `heartbeat.trigger`. (no @Returns declared) */
export type HeartbeatTriggerReturn = unknown;

/** Input shape for `hooks.create`. */
export type HooksCreateInput = {
  action?: string;
  agent?: string;
  async?: boolean;
  barrier?: string;
  cooldown?: string;
  dedupeKey?: string;
  disabled?: boolean;
  event?: string;
  matcher?: string;
  message?: string;
  name: string;
  role?: string;
  scope?: string;
  session?: string;
  targetSession?: string;
  targetTask?: string;
  task?: string;
  workspace?: string;
};

/** Return shape for `hooks.create`. (no @Returns declared) */
export type HooksCreateReturn = unknown;

/** Input shape for `hooks.disable`. */
export type HooksDisableInput = {
  id: string;
};

/** Return shape for `hooks.disable`. (no @Returns declared) */
export type HooksDisableReturn = unknown;

/** Input shape for `hooks.enable`. */
export type HooksEnableInput = {
  id: string;
};

/** Return shape for `hooks.enable`. (no @Returns declared) */
export type HooksEnableReturn = unknown;

/** Input shape for `hooks.list`. */
export type HooksListInput = Record<string, never>;

/** Return shape for `hooks.list`. (no @Returns declared) */
export type HooksListReturn = unknown;

/** Input shape for `hooks.rm`. */
export type HooksRmInput = {
  id: string;
};

/** Return shape for `hooks.rm`. (no @Returns declared) */
export type HooksRmReturn = unknown;

/** Input shape for `hooks.show`. */
export type HooksShowInput = {
  id: string;
};

/** Return shape for `hooks.show`. (no @Returns declared) */
export type HooksShowReturn = unknown;

/** Input shape for `hooks.test`. */
export type HooksTestInput = {
  id: string;
};

/** Return shape for `hooks.test`. (no @Returns declared) */
export type HooksTestReturn = unknown;

/** Input shape for `image.atlas.split`. */
export type ImageAtlasSplitInput = {
  account?: string;
  background?: string;
  caption?: string;
  channel?: string;
  cols?: string;
  fit?: string;
  fuzz?: string;
  input: string;
  mode?: string;
  names?: string;
  output?: string;
  pad?: string;
  parentArtifact?: string;
  rows?: string;
  send?: boolean;
  size?: string;
  threadId?: string;
  to?: string;
};

/** Return shape for `image.atlas.split`. (no @Returns declared) */
export type ImageAtlasSplitReturn = unknown;

/** Input shape for `image.generate`. */
export type ImageGenerateInput = {
  artifactId?: string;
  aspect?: string;
  async?: boolean;
  asyncWorker?: boolean;
  background?: string;
  caption?: string;
  compression?: string;
  format?: string;
  mode?: string;
  model?: string;
  output?: string;
  prompt: string;
  provider?: string;
  quality?: string;
  send?: boolean;
  size?: string;
  source?: string;
  sync?: boolean;
};

/** Return shape for `image.generate`. (no @Returns declared) */
export type ImageGenerateReturn = unknown;

/** Input shape for `insights.create`. */
export type InsightsCreateInput = {
  agent?: string;
  artifact?: string;
  autoContext?: boolean;
  comment?: string;
  confidence?: string;
  detail?: string;
  importance?: string;
  kind?: string;
  linkId?: string;
  linkType?: string;
  profile?: string;
  session?: string;
  summary: string;
  task?: string;
};

/** Return shape for `insights.create`. (no @Returns declared) */
export type InsightsCreateReturn = unknown;

/** Input shape for `insights.list`. */
export type InsightsListInput = {
  agent?: string;
  confidence?: string;
  importance?: string;
  kind?: string;
  limit?: string;
  profile?: string;
  query?: string;
  session?: string;
  task?: string;
};

/** Return shape for `insights.list`. (no @Returns declared) */
export type InsightsListReturn = unknown;

/** Input shape for `insights.search`. */
export type InsightsSearchInput = {
  limit?: string;
  text: string;
};

/** Return shape for `insights.search`. (no @Returns declared) */
export type InsightsSearchReturn = unknown;

/** Input shape for `insights.show`. */
export type InsightsShowInput = {
  id: string;
};

/** Return shape for `insights.show`. (no @Returns declared) */
export type InsightsShowReturn = unknown;

/** Input shape for `instances.connect`. */
export type InstancesConnectInput = {
  agent?: string;
  channel?: string;
  name: string;
};

/** Return shape for `instances.connect`. (no @Returns declared) */
export type InstancesConnectReturn = unknown;

/** Input shape for `instances.create`. */
export type InstancesCreateInput = {
  agent?: string;
  channel?: string;
  dmPolicy?: string;
  groupPolicy?: string;
  name: string;
};

/** Return shape for `instances.create`. (no @Returns declared) */
export type InstancesCreateReturn = unknown;

/** Input shape for `instances.delete`. */
export type InstancesDeleteInput = {
  name: string;
};

/** Return shape for `instances.delete`. (no @Returns declared) */
export type InstancesDeleteReturn = unknown;

/** Input shape for `instances.deleted`. */
export type InstancesDeletedInput = Record<string, never>;

/** Return shape for `instances.deleted`. (no @Returns declared) */
export type InstancesDeletedReturn = unknown;

/** Input shape for `instances.disable`. */
export type InstancesDisableInput = {
  target: string;
};

/** Return shape for `instances.disable`. (no @Returns declared) */
export type InstancesDisableReturn = unknown;

/** Input shape for `instances.disconnect`. */
export type InstancesDisconnectInput = {
  name: string;
};

/** Return shape for `instances.disconnect`. (no @Returns declared) */
export type InstancesDisconnectReturn = unknown;

/** Input shape for `instances.enable`. */
export type InstancesEnableInput = {
  target: string;
};

/** Return shape for `instances.enable`. (no @Returns declared) */
export type InstancesEnableReturn = unknown;

/** Input shape for `instances.get`. */
export type InstancesGetInput = {
  key: string;
  name: string;
};

/** Return shape for `instances.get`. (no @Returns declared) */
export type InstancesGetReturn = unknown;

/** Input shape for `instances.list`. */
export type InstancesListInput = Record<string, never>;

/** Return shape for `instances.list`. (no @Returns declared) */
export type InstancesListReturn = unknown;

/** Input shape for `instances.pending.approve`. */
export type InstancesPendingApproveInput = {
  agent?: string;
  contact: string;
  name: string;
};

/** Return shape for `instances.pending.approve`. (no @Returns declared) */
export type InstancesPendingApproveReturn = unknown;

/** Input shape for `instances.pending.list`. */
export type InstancesPendingListInput = {
  name: string;
};

/** Return shape for `instances.pending.list`. (no @Returns declared) */
export type InstancesPendingListReturn = unknown;

/** Input shape for `instances.pending.reject`. */
export type InstancesPendingRejectInput = {
  contact: string;
  name: string;
};

/** Return shape for `instances.pending.reject`. (no @Returns declared) */
export type InstancesPendingRejectReturn = unknown;

/** Input shape for `instances.restore`. */
export type InstancesRestoreInput = {
  name: string;
};

/** Return shape for `instances.restore`. (no @Returns declared) */
export type InstancesRestoreReturn = unknown;

/** Input shape for `instances.routes.add`. */
export type InstancesRoutesAddInput = {
  agent: string;
  allowRuntimeMismatch?: boolean;
  channel?: string;
  dmScope?: string;
  name: string;
  pattern: string;
  policy?: string;
  priority?: string;
  session?: string;
};

/** Return shape for `instances.routes.add`. (no @Returns declared) */
export type InstancesRoutesAddReturn = unknown;

/** Input shape for `instances.routes.deleted`. */
export type InstancesRoutesDeletedInput = {
  name?: string;
};

/** Return shape for `instances.routes.deleted`. (no @Returns declared) */
export type InstancesRoutesDeletedReturn = unknown;

/** Input shape for `instances.routes.list`. */
export type InstancesRoutesListInput = {
  name: string;
};

/** Return shape for `instances.routes.list`. (no @Returns declared) */
export type InstancesRoutesListReturn = unknown;

/** Input shape for `instances.routes.remove`. */
export type InstancesRoutesRemoveInput = {
  allowRuntimeMismatch?: boolean;
  name: string;
  pattern: string;
};

/** Return shape for `instances.routes.remove`. (no @Returns declared) */
export type InstancesRoutesRemoveReturn = unknown;

/** Input shape for `instances.routes.restore`. */
export type InstancesRoutesRestoreInput = {
  allowRuntimeMismatch?: boolean;
  name: string;
  pattern: string;
};

/** Return shape for `instances.routes.restore`. (no @Returns declared) */
export type InstancesRoutesRestoreReturn = unknown;

/** Input shape for `instances.routes.set`. */
export type InstancesRoutesSetInput = {
  allowRuntimeMismatch?: boolean;
  key: string;
  name: string;
  pattern: string;
  value: string;
};

/** Return shape for `instances.routes.set`. (no @Returns declared) */
export type InstancesRoutesSetReturn = unknown;

/** Input shape for `instances.routes.show`. */
export type InstancesRoutesShowInput = {
  name: string;
  pattern: string;
};

/** Return shape for `instances.routes.show`. (no @Returns declared) */
export type InstancesRoutesShowReturn = unknown;

/** Input shape for `instances.set`. */
export type InstancesSetInput = {
  key: string;
  name: string;
  value: string;
};

/** Return shape for `instances.set`. (no @Returns declared) */
export type InstancesSetReturn = unknown;

/** Input shape for `instances.show`. */
export type InstancesShowInput = {
  name: string;
};

/** Return shape for `instances.show`. (no @Returns declared) */
export type InstancesShowReturn = unknown;

/** Input shape for `instances.status`. */
export type InstancesStatusInput = {
  name: string;
};

/** Return shape for `instances.status`. (no @Returns declared) */
export type InstancesStatusReturn = unknown;

/** Input shape for `instances.target`. */
export type InstancesTargetInput = {
  channel?: string;
  name: string;
  pattern?: string;
};

/** Return shape for `instances.target`. (no @Returns declared) */
export type InstancesTargetReturn = unknown;

/** Input shape for `media.send`. */
export type MediaSendInput = {
  account?: string;
  caption?: string;
  channel?: string;
  filePath: string;
  ptt?: boolean;
  threadId?: string;
  to?: string;
};

/** Return shape for `media.send`. (no @Returns declared) */
export type MediaSendReturn = unknown;

/** Input shape for `permissions.check`. */
export type PermissionsCheckInput = {
  object: string;
  permission: string;
  subject: string;
};

/** Return shape for `permissions.check`. (no @Returns declared) */
export type PermissionsCheckReturn = unknown;

/** Input shape for `permissions.clear`. */
export type PermissionsClearInput = {
  all?: boolean;
};

/** Return shape for `permissions.clear`. (no @Returns declared) */
export type PermissionsClearReturn = unknown;

/** Input shape for `permissions.grant`. */
export type PermissionsGrantInput = {
  object: string;
  relation: string;
  subject: string;
};

/** Return shape for `permissions.grant`. (no @Returns declared) */
export type PermissionsGrantReturn = unknown;

/** Input shape for `permissions.init`. */
export type PermissionsInitInput = {
  subject: string;
  template: string;
};

/** Return shape for `permissions.init`. (no @Returns declared) */
export type PermissionsInitReturn = unknown;

/** Input shape for `permissions.list`. */
export type PermissionsListInput = {
  object?: string;
  relation?: string;
  source?: string;
  subject?: string;
};

/** Return shape for `permissions.list`. (no @Returns declared) */
export type PermissionsListReturn = unknown;

/** Input shape for `permissions.revoke`. */
export type PermissionsRevokeInput = {
  object: string;
  relation: string;
  subject: string;
};

/** Return shape for `permissions.revoke`. (no @Returns declared) */
export type PermissionsRevokeReturn = unknown;

/** Input shape for `permissions.sync`. */
export type PermissionsSyncInput = Record<string, never>;

/** Return shape for `permissions.sync`. (no @Returns declared) */
export type PermissionsSyncReturn = unknown;

/** Input shape for `projects.create`. */
export type ProjectsCreateInput = {
  hypothesis?: string;
  lastSignalAt?: string;
  nextStep?: string;
  ownerAgent?: string;
  session?: string;
  slug?: string;
  status?: string;
  summary?: string;
  title: string;
};

/** Return shape for `projects.create`. (no @Returns declared) */
export type ProjectsCreateReturn = unknown;

/** Input shape for `projects.fixtures.seed`. */
export type ProjectsFixturesSeedInput = {
  ownerAgent?: string;
};

/** Return shape for `projects.fixtures.seed`. (no @Returns declared) */
export type ProjectsFixturesSeedReturn = unknown;

/** Input shape for `projects.init`. */
export type ProjectsInitInput = {
  hypothesis?: string;
  lastSignalAt?: string;
  nextStep?: string;
  ownerAgent?: string;
  resource?: string[];
  session?: string;
  slug?: string;
  status?: string;
  summary?: string;
  title: string;
  workflowRun?: string[];
  workflowTemplate?: string[];
};

/** Return shape for `projects.init`. (no @Returns declared) */
export type ProjectsInitReturn = unknown;

/** Input shape for `projects.link`. */
export type ProjectsLinkInput = {
  assetType: string;
  label?: string;
  meta?: string;
  project: string;
  resourceType?: string;
  role?: string;
  target: string;
};

/** Return shape for `projects.link`. (no @Returns declared) */
export type ProjectsLinkReturn = unknown;

/** Input shape for `projects.list`. */
export type ProjectsListInput = {
  status?: string;
};

/** Return shape for `projects.list`. (no @Returns declared) */
export type ProjectsListReturn = unknown;

/** Input shape for `projects.next`. */
export type ProjectsNextInput = {
  status?: string;
};

/** Return shape for `projects.next`. (no @Returns declared) */
export type ProjectsNextReturn = unknown;

/** Input shape for `projects.resources.add`. */
export type ProjectsResourcesAddInput = {
  label?: string;
  meta?: string;
  project: string;
  role?: string;
  target: string;
  type?: string;
};

/** Return shape for `projects.resources.add`. (no @Returns declared) */
export type ProjectsResourcesAddReturn = unknown;

/** Input shape for `projects.resources.import`. */
export type ProjectsResourcesImportInput = {
  group?: string[];
  meta?: string;
  project: string;
  repo?: string[];
  role?: string;
  url?: string[];
  worktree?: string[];
};

/** Return shape for `projects.resources.import`. (no @Returns declared) */
export type ProjectsResourcesImportReturn = unknown;

/** Input shape for `projects.resources.list`. */
export type ProjectsResourcesListInput = {
  project: string;
  type?: string;
};

/** Return shape for `projects.resources.list`. (no @Returns declared) */
export type ProjectsResourcesListReturn = unknown;

/** Input shape for `projects.resources.show`. */
export type ProjectsResourcesShowInput = {
  project: string;
  resource: string;
};

/** Return shape for `projects.resources.show`. (no @Returns declared) */
export type ProjectsResourcesShowReturn = unknown;

/** Input shape for `projects.show`. */
export type ProjectsShowInput = {
  project: string;
};

/** Return shape for `projects.show`. (no @Returns declared) */
export type ProjectsShowReturn = unknown;

/** Input shape for `projects.status`. */
export type ProjectsStatusInput = {
  project: string;
};

/** Return shape for `projects.status`. (no @Returns declared) */
export type ProjectsStatusReturn = unknown;

/** Input shape for `projects.tasks.attach`. */
export type ProjectsTasksAttachInput = {
  agent?: string;
  dispatch?: boolean;
  nodeKey: string;
  project: string;
  session?: string;
  taskId: string;
  workflow?: string;
};

/** Return shape for `projects.tasks.attach`. (no @Returns declared) */
export type ProjectsTasksAttachReturn = unknown;

/** Input shape for `projects.tasks.create`. */
export type ProjectsTasksCreateInput = {
  agent?: string;
  dispatch?: boolean;
  instructions?: string;
  nodeKey: string;
  priority?: string;
  profile?: string;
  project: string;
  session?: string;
  title: string;
  workflow?: string;
};

/** Return shape for `projects.tasks.create`. (no @Returns declared) */
export type ProjectsTasksCreateReturn = unknown;

/** Input shape for `projects.tasks.dispatch`. */
export type ProjectsTasksDispatchInput = {
  agent?: string;
  project: string;
  session?: string;
  taskId: string;
};

/** Return shape for `projects.tasks.dispatch`. (no @Returns declared) */
export type ProjectsTasksDispatchReturn = unknown;

/** Input shape for `projects.update`. */
export type ProjectsUpdateInput = {
  hypothesis?: string;
  lastSignalAt?: string;
  nextStep?: string;
  ownerAgent?: string;
  project: string;
  session?: string;
  status?: string;
  summary?: string;
  title?: string;
  touchSignal?: boolean;
};

/** Return shape for `projects.update`. (no @Returns declared) */
export type ProjectsUpdateReturn = unknown;

/** Input shape for `projects.workflows.attach`. */
export type ProjectsWorkflowsAttachInput = {
  project: string;
  role?: string;
  runId: string;
};

/** Return shape for `projects.workflows.attach`. (no @Returns declared) */
export type ProjectsWorkflowsAttachReturn = unknown;

/** Input shape for `projects.workflows.start`. */
export type ProjectsWorkflowsStartInput = {
  project: string;
  role?: string;
  runId?: string;
  specId: string;
};

/** Return shape for `projects.workflows.start`. (no @Returns declared) */
export type ProjectsWorkflowsStartReturn = unknown;

/** Input shape for `prox.calls.cancel`. */
export type ProxCallsCancelInput = {
  call_request_id: string;
  reason?: string;
};

/** Return shape for `prox.calls.cancel`. (no @Returns declared) */
export type ProxCallsCancelReturn = unknown;

/** Input shape for `prox.calls.events`. */
export type ProxCallsEventsInput = {
  call_request_id: string;
};

/** Return shape for `prox.calls.events`. (no @Returns declared) */
export type ProxCallsEventsReturn = unknown;

/** Input shape for `prox.calls.profiles.configure`. */
export type ProxCallsProfilesConfigureInput = {
  agentId?: string;
  dynamicPlaceholder?: string[];
  firstMessage?: string;
  language?: string;
  profile_id: string;
  prompt?: string;
  provider?: string;
  skipProviderSync?: boolean;
  systemPromptPath?: string;
  twilioNumberId?: string;
  voicemailPolicy?: string;
};

/** Return shape for `prox.calls.profiles.configure`. (no @Returns declared) */
export type ProxCallsProfilesConfigureReturn = unknown;

/** Input shape for `prox.calls.profiles.list`. */
export type ProxCallsProfilesListInput = Record<string, never>;

/** Return shape for `prox.calls.profiles.list`. (no @Returns declared) */
export type ProxCallsProfilesListReturn = unknown;

/** Input shape for `prox.calls.profiles.show`. */
export type ProxCallsProfilesShowInput = {
  profile_id: string;
};

/** Return shape for `prox.calls.profiles.show`. (no @Returns declared) */
export type ProxCallsProfilesShowReturn = unknown;

/** Input shape for `prox.calls.request`. */
export type ProxCallsRequestInput = {
  force?: boolean;
  person?: string;
  phone?: string;
  priority?: string;
  profile?: string;
  reason?: string;
  skipOriginNotify?: boolean;
  var?: string[];
};

/** Return shape for `prox.calls.request`. (no @Returns declared) */
export type ProxCallsRequestReturn = unknown;

/** Input shape for `prox.calls.rules`. */
export type ProxCallsRulesInput = {
  scope?: string;
};

/** Return shape for `prox.calls.rules`. (no @Returns declared) */
export type ProxCallsRulesReturn = unknown;

/** Input shape for `prox.calls.show`. */
export type ProxCallsShowInput = {
  call_request_id: string;
};

/** Return shape for `prox.calls.show`. (no @Returns declared) */
export type ProxCallsShowReturn = unknown;

/** Input shape for `prox.calls.tools.bind`. */
export type ProxCallsToolsBindInput = {
  profile_id: string;
  providerToolName?: string;
  required?: boolean;
  toolPrompt?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.bind`. (no @Returns declared) */
export type ProxCallsToolsBindReturn = unknown;

/** Input shape for `prox.calls.tools.configure`. */
export type ProxCallsToolsConfigureInput = {
  enabled?: string;
  timeoutMs?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.configure`. (no @Returns declared) */
export type ProxCallsToolsConfigureReturn = unknown;

/** Input shape for `prox.calls.tools.create`. */
export type ProxCallsToolsCreateInput = {
  description?: string;
  executor?: string;
  inputSchema?: string;
  name?: string;
  outputSchema?: string;
  sideEffect?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.create`. (no @Returns declared) */
export type ProxCallsToolsCreateReturn = unknown;

/** Input shape for `prox.calls.tools.list`. */
export type ProxCallsToolsListInput = {
  profile?: string;
};

/** Return shape for `prox.calls.tools.list`. (no @Returns declared) */
export type ProxCallsToolsListReturn = unknown;

/** Input shape for `prox.calls.tools.run`. */
export type ProxCallsToolsRunInput = {
  dryRun?: boolean;
  input?: string;
  profile?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.run`. (no @Returns declared) */
export type ProxCallsToolsRunReturn = unknown;

/** Input shape for `prox.calls.tools.runs`. */
export type ProxCallsToolsRunsInput = {
  call_request_id: string;
};

/** Return shape for `prox.calls.tools.runs`. (no @Returns declared) */
export type ProxCallsToolsRunsReturn = unknown;

/** Input shape for `prox.calls.tools.show`. */
export type ProxCallsToolsShowInput = {
  tool_id: string;
};

/** Return shape for `prox.calls.tools.show`. (no @Returns declared) */
export type ProxCallsToolsShowReturn = unknown;

/** Input shape for `prox.calls.tools.unbind`. */
export type ProxCallsToolsUnbindInput = {
  profile_id: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.unbind`. (no @Returns declared) */
export type ProxCallsToolsUnbindReturn = unknown;

/** Input shape for `prox.calls.transcript`. */
export type ProxCallsTranscriptInput = {
  call_request_id: string;
  sync?: boolean;
};

/** Return shape for `prox.calls.transcript`. (no @Returns declared) */
export type ProxCallsTranscriptReturn = unknown;

/** Input shape for `prox.calls.voice-agents.bind-tool`. */
export type ProxCallsVoiceAgentsBindToolInput = {
  providerToolName?: string;
  tool_id: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.bind-tool`. (no @Returns declared) */
export type ProxCallsVoiceAgentsBindToolReturn = unknown;

/** Input shape for `prox.calls.voice-agents.configure`. */
export type ProxCallsVoiceAgentsConfigureInput = {
  firstMessage?: string;
  providerAgentId?: string;
  systemPromptPath?: string;
  voiceId?: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.configure`. (no @Returns declared) */
export type ProxCallsVoiceAgentsConfigureReturn = unknown;

/** Input shape for `prox.calls.voice-agents.create`. */
export type ProxCallsVoiceAgentsCreateInput = {
  name?: string;
  provider?: string;
  systemPromptPath?: string;
  voiceId?: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.create`. (no @Returns declared) */
export type ProxCallsVoiceAgentsCreateReturn = unknown;

/** Input shape for `prox.calls.voice-agents.list`. */
export type ProxCallsVoiceAgentsListInput = Record<string, never>;

/** Return shape for `prox.calls.voice-agents.list`. (no @Returns declared) */
export type ProxCallsVoiceAgentsListReturn = unknown;

/** Input shape for `prox.calls.voice-agents.show`. */
export type ProxCallsVoiceAgentsShowInput = {
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.show`. (no @Returns declared) */
export type ProxCallsVoiceAgentsShowReturn = unknown;

/** Input shape for `prox.calls.voice-agents.sync`. */
export type ProxCallsVoiceAgentsSyncInput = {
  dryRun?: boolean;
  provider?: boolean;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.sync`. (no @Returns declared) */
export type ProxCallsVoiceAgentsSyncReturn = unknown;

/** Input shape for `prox.calls.voice-agents.unbind-tool`. */
export type ProxCallsVoiceAgentsUnbindToolInput = {
  tool_id: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.unbind-tool`. (no @Returns declared) */
export type ProxCallsVoiceAgentsUnbindToolReturn = unknown;

/** Input shape for `react.send`. */
export type ReactSendInput = {
  emoji: string;
  messageId: string;
};

/** Return shape for `react.send`. (no @Returns declared) */
export type ReactSendReturn = unknown;

/** Input shape for `routes.explain`. */
export type RoutesExplainInput = {
  channel?: string;
  name: string;
  pattern: string;
};

/** Return shape for `routes.explain`. (no @Returns declared) */
export type RoutesExplainReturn = unknown;

/** Input shape for `routes.list`. */
export type RoutesListInput = {
  name?: string;
};

/** Return shape for `routes.list`. (no @Returns declared) */
export type RoutesListReturn = unknown;

/** Input shape for `routes.show`. */
export type RoutesShowInput = {
  name: string;
  pattern: string;
};

/** Return shape for `routes.show`. (no @Returns declared) */
export type RoutesShowReturn = unknown;

/** Input shape for `sdk.client.check`. */
export type SdkClientCheckInput = {
  out?: string;
  version?: string;
};

/** Return shape for `sdk.client.check`. (no @Returns declared) */
export type SdkClientCheckReturn = unknown;

/** Input shape for `sdk.client.generate`. */
export type SdkClientGenerateInput = {
  out?: string;
  version?: string;
};

/** Return shape for `sdk.client.generate`. (no @Returns declared) */
export type SdkClientGenerateReturn = unknown;

/** Input shape for `sdk.openapi.check`. */
export type SdkOpenapiCheckInput = {
  against?: string;
};

/** Return shape for `sdk.openapi.check`. (no @Returns declared) */
export type SdkOpenapiCheckReturn = unknown;

/** Input shape for `sdk.openapi.emit`. */
export type SdkOpenapiEmitInput = {
  out?: string;
  stdout?: boolean;
};

/** Return shape for `sdk.openapi.emit`. (no @Returns declared) */
export type SdkOpenapiEmitReturn = unknown;

/** Input shape for `service.start`. */
export type ServiceStartInput = Record<string, never>;

/** Return shape for `service.start`. (no @Returns declared) */
export type ServiceStartReturn = unknown;

/** Input shape for `service.tui`. */
export type ServiceTuiInput = {
  session?: string;
};

/** Return shape for `service.tui`. (no @Returns declared) */
export type ServiceTuiReturn = unknown;

/** Input shape for `service.wa`. */
export type ServiceWaInput = Record<string, never>;

/** Return shape for `service.wa`. (no @Returns declared) */
export type ServiceWaReturn = unknown;

/** Input shape for `sessions.answer`. */
export type SessionsAnswerInput = {
  barrier?: string;
  channel?: string;
  message: string;
  sender?: string;
  target: string;
  to?: string;
};

/** Return shape for `sessions.answer`. (no @Returns declared) */
export type SessionsAnswerReturn = unknown;

/** Input shape for `sessions.ask`. */
export type SessionsAskInput = {
  barrier?: string;
  channel?: string;
  message: string;
  sender?: string;
  target: string;
  to?: string;
};

/** Return shape for `sessions.ask`. (no @Returns declared) */
export type SessionsAskReturn = unknown;

/** Input shape for `sessions.debug`. */
export type SessionsDebugInput = {
  nameOrKey?: string;
  timeout?: string;
};

/** Return shape for `sessions.debug`. (no @Returns declared) */
export type SessionsDebugReturn = unknown;

/** Input shape for `sessions.delete`. */
export type SessionsDeleteInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.delete`. (no @Returns declared) */
export type SessionsDeleteReturn = unknown;

/** Input shape for `sessions.execute`. */
export type SessionsExecuteInput = {
  barrier?: string;
  channel?: string;
  message: string;
  target: string;
  to?: string;
};

/** Return shape for `sessions.execute`. (no @Returns declared) */
export type SessionsExecuteReturn = unknown;

/** Input shape for `sessions.extend`. */
export type SessionsExtendInput = {
  duration?: string;
  nameOrKey: string;
};

/** Return shape for `sessions.extend`. (no @Returns declared) */
export type SessionsExtendReturn = unknown;

/** Input shape for `sessions.info`. */
export type SessionsInfoInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.info`. (no @Returns declared) */
export type SessionsInfoReturn = unknown;

/** Input shape for `sessions.inform`. */
export type SessionsInformInput = {
  barrier?: string;
  channel?: string;
  message: string;
  target: string;
  to?: string;
};

/** Return shape for `sessions.inform`. (no @Returns declared) */
export type SessionsInformReturn = unknown;

/** Input shape for `sessions.keep`. */
export type SessionsKeepInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.keep`. (no @Returns declared) */
export type SessionsKeepReturn = unknown;

/** Input shape for `sessions.list`. */
export type SessionsListInput = {
  agent?: string;
  ephemeral?: boolean;
};

/** Return shape for `sessions.list`. (no @Returns declared) */
export type SessionsListReturn = unknown;

/** Input shape for `sessions.read`. */
export type SessionsReadInput = {
  count?: string;
  nameOrKey: string;
};

/** Return shape for `sessions.read`. (no @Returns declared) */
export type SessionsReadReturn = unknown;

/** Input shape for `sessions.rename`. */
export type SessionsRenameInput = {
  nameOrKey: string;
  newName: string;
};

/** Return shape for `sessions.rename`. (no @Returns declared) */
export type SessionsRenameReturn = unknown;

/** Input shape for `sessions.reset`. */
export type SessionsResetInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.reset`. (no @Returns declared) */
export type SessionsResetReturn = unknown;

/** Input shape for `sessions.runtime.follow-up`. */
export type SessionsRuntimeFollowUpInput = {
  expectedTurn?: string;
  session: string;
  text: string;
  thread?: string;
  turn?: string;
};

/** Return shape for `sessions.runtime.follow-up`. (no @Returns declared) */
export type SessionsRuntimeFollowUpReturn = unknown;

/** Input shape for `sessions.runtime.fork`. */
export type SessionsRuntimeForkInput = {
  cwd?: string;
  path?: string;
  session: string;
  threadId?: string;
};

/** Return shape for `sessions.runtime.fork`. (no @Returns declared) */
export type SessionsRuntimeForkReturn = unknown;

/** Input shape for `sessions.runtime.interrupt`. */
export type SessionsRuntimeInterruptInput = {
  session: string;
  thread?: string;
  turn?: string;
};

/** Return shape for `sessions.runtime.interrupt`. (no @Returns declared) */
export type SessionsRuntimeInterruptReturn = unknown;

/** Input shape for `sessions.runtime.list`. */
export type SessionsRuntimeListInput = {
  archived?: boolean;
  cursor?: string;
  cwd?: string;
  limit?: string;
  search?: string;
  session: string;
};

/** Return shape for `sessions.runtime.list`. (no @Returns declared) */
export type SessionsRuntimeListReturn = unknown;

/** Input shape for `sessions.runtime.read`. */
export type SessionsRuntimeReadInput = {
  session: string;
  summaryOnly?: boolean;
  threadId?: string;
};

/** Return shape for `sessions.runtime.read`. (no @Returns declared) */
export type SessionsRuntimeReadReturn = unknown;

/** Input shape for `sessions.runtime.rollback`. */
export type SessionsRuntimeRollbackInput = {
  session: string;
  thread?: string;
  turns?: string;
};

/** Return shape for `sessions.runtime.rollback`. (no @Returns declared) */
export type SessionsRuntimeRollbackReturn = unknown;

/** Input shape for `sessions.runtime.steer`. */
export type SessionsRuntimeSteerInput = {
  expectedTurn?: string;
  session: string;
  text: string;
  thread?: string;
  turn?: string;
};

/** Return shape for `sessions.runtime.steer`. (no @Returns declared) */
export type SessionsRuntimeSteerReturn = unknown;

/** Input shape for `sessions.send`. */
export type SessionsSendInput = {
  agent?: string;
  barrier?: string;
  channel?: string;
  interactive?: boolean;
  nameOrKey: string;
  prompt?: string;
  to?: string;
  wait?: boolean;
};

/** Return shape for `sessions.send`. (no @Returns declared) */
export type SessionsSendReturn = unknown;

/** Input shape for `sessions.set-display`. */
export type SessionsSetDisplayInput = {
  displayName: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-display`. (no @Returns declared) */
export type SessionsSetDisplayReturn = unknown;

/** Input shape for `sessions.set-model`. */
export type SessionsSetModelInput = {
  model: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-model`. (no @Returns declared) */
export type SessionsSetModelReturn = unknown;

/** Input shape for `sessions.set-thinking`. */
export type SessionsSetThinkingInput = {
  level: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-thinking`. (no @Returns declared) */
export type SessionsSetThinkingReturn = unknown;

/** Input shape for `sessions.set-ttl`. */
export type SessionsSetTtlInput = {
  duration: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-ttl`. (no @Returns declared) */
export type SessionsSetTtlReturn = unknown;

/** Input shape for `sessions.trace`. */
export type SessionsTraceInput = {
  correlation?: string;
  explain?: boolean;
  includeStream?: boolean;
  limit?: string;
  message?: string;
  nameOrKey: string;
  only?: string;
  raw?: boolean;
  run?: string;
  showSystemPrompt?: boolean;
  showUserPrompt?: boolean;
  since?: string;
  turn?: string;
  until?: string;
};

/** Return shape for `sessions.trace`. (no @Returns declared) */
export type SessionsTraceReturn = unknown;

/** Input shape for `settings.delete`. */
export type SettingsDeleteInput = {
  key: string;
};

/** Return shape for `settings.delete`. (no @Returns declared) */
export type SettingsDeleteReturn = unknown;

/** Input shape for `settings.get`. */
export type SettingsGetInput = {
  key: string;
};

/** Return shape for `settings.get`. (no @Returns declared) */
export type SettingsGetReturn = unknown;

/** Input shape for `settings.list`. */
export type SettingsListInput = {
  legacy?: boolean;
};

/** Return shape for `settings.list`. (no @Returns declared) */
export type SettingsListReturn = unknown;

/** Input shape for `settings.set`. */
export type SettingsSetInput = {
  key: string;
  value: string;
};

/** Return shape for `settings.set`. (no @Returns declared) */
export type SettingsSetReturn = unknown;

/** Input shape for `skills.install`. */
export type SkillsInstallInput = {
  all?: boolean;
  name?: string;
  overwrite?: boolean;
  plugin?: string;
  skill?: string;
  skipCodexSync?: boolean;
  source?: string;
};

/** Return shape for `skills.install`. (no @Returns declared) */
export type SkillsInstallReturn = unknown;

/** Input shape for `skills.list`. */
export type SkillsListInput = {
  codex?: boolean;
  installed?: boolean;
  source?: string;
};

/** Return shape for `skills.list`. (no @Returns declared) */
export type SkillsListReturn = unknown;

/** Input shape for `skills.show`. */
export type SkillsShowInput = {
  installed?: boolean;
  name: string;
  source?: string;
};

/** Return shape for `skills.show`. (no @Returns declared) */
export type SkillsShowReturn = unknown;

/** Input shape for `skills.sync`. */
export type SkillsSyncInput = Record<string, never>;

/** Return shape for `skills.sync`. (no @Returns declared) */
export type SkillsSyncReturn = unknown;

/** Input shape for `specs.get`. */
export type SpecsGetInput = {
  id: string;
  mode?: string;
};

/** Return shape for `specs.get`. (no @Returns declared) */
export type SpecsGetReturn = unknown;

/** Input shape for `specs.list`. */
export type SpecsListInput = {
  domain?: string;
  kind?: string;
};

/** Return shape for `specs.list`. (no @Returns declared) */
export type SpecsListReturn = unknown;

/** Input shape for `specs.new`. */
export type SpecsNewInput = {
  full?: boolean;
  id: string;
  kind?: string;
  title?: string;
};

/** Return shape for `specs.new`. (no @Returns declared) */
export type SpecsNewReturn = unknown;

/** Input shape for `specs.sync`. */
export type SpecsSyncInput = Record<string, never>;

/** Return shape for `specs.sync`. (no @Returns declared) */
export type SpecsSyncReturn = unknown;

/** Input shape for `stickers.add`. */
export type StickersAddInput = {
  agents?: string;
  avoid?: string;
  channels?: string;
  description?: string;
  disabled?: boolean;
  id: string;
  label?: string;
  mediaPath: string;
  overwrite?: boolean;
};

/** Return shape for `stickers.add`. (no @Returns declared) */
export type StickersAddReturn = unknown;

/** Input shape for `stickers.list`. */
export type StickersListInput = Record<string, never>;

/** Return shape for `stickers.list`. (no @Returns declared) */
export type StickersListReturn = unknown;

/** Input shape for `stickers.remove`. */
export type StickersRemoveInput = {
  id: string;
};

/** Return shape for `stickers.remove`. (no @Returns declared) */
export type StickersRemoveReturn = unknown;

/** Input shape for `stickers.send`. */
export type StickersSendInput = {
  account?: string;
  channel?: string;
  id: string;
  session?: string;
  to?: string;
};

/** Return shape for `stickers.send`. (no @Returns declared) */
export type StickersSendReturn = unknown;

/** Input shape for `stickers.show`. */
export type StickersShowInput = {
  id: string;
};

/** Return shape for `stickers.show`. (no @Returns declared) */
export type StickersShowReturn = unknown;

/** Input shape for `tags.attach`. */
export type TagsAttachInput = {
  agent?: string;
  meta?: string;
  session?: string;
  slug: string;
};

/** Return shape for `tags.attach`. (no @Returns declared) */
export type TagsAttachReturn = unknown;

/** Input shape for `tags.create`. */
export type TagsCreateInput = {
  description?: string;
  kind?: string;
  label?: string;
  meta?: string;
  slug: string;
};

/** Return shape for `tags.create`. (no @Returns declared) */
export type TagsCreateReturn = unknown;

/** Input shape for `tags.detach`. */
export type TagsDetachInput = {
  agent?: string;
  session?: string;
  slug: string;
};

/** Return shape for `tags.detach`. (no @Returns declared) */
export type TagsDetachReturn = unknown;

/** Input shape for `tags.list`. */
export type TagsListInput = Record<string, never>;

/** Return shape for `tags.list`. (no @Returns declared) */
export type TagsListReturn = unknown;

/** Input shape for `tags.search`. */
export type TagsSearchInput = {
  agent?: string;
  session?: string;
  tag?: string;
};

/** Return shape for `tags.search`. (no @Returns declared) */
export type TagsSearchReturn = unknown;

/** Input shape for `tags.show`. */
export type TagsShowInput = {
  slug: string;
};

/** Return shape for `tags.show`. (no @Returns declared) */
export type TagsShowReturn = unknown;

/** Input shape for `tasks.archive`. */
export type TasksArchiveInput = {
  reason?: string;
  taskId: string;
};

/** Return shape for `tasks.archive`. (no @Returns declared) */
export type TasksArchiveReturn = unknown;

/** Input shape for `tasks.automations.add`. */
export type TasksAutomationsAddInput = {
  agent?: string;
  checkpoint?: string;
  detached?: boolean;
  disabled?: boolean;
  filter?: string;
  freshCheckpoint?: boolean;
  freshReportEvents?: boolean;
  freshReportTo?: boolean;
  freshWorktree?: boolean;
  input?: string[];
  instructions?: string;
  name: string;
  on?: string;
  priority?: string;
  profile?: string;
  reportEvents?: string;
  reportTo?: string;
  session?: string;
  title?: string;
};

/** Return shape for `tasks.automations.add`. (no @Returns declared) */
export type TasksAutomationsAddReturn = unknown;

/** Input shape for `tasks.automations.disable`. */
export type TasksAutomationsDisableInput = {
  id: string;
};

/** Return shape for `tasks.automations.disable`. (no @Returns declared) */
export type TasksAutomationsDisableReturn = unknown;

/** Input shape for `tasks.automations.enable`. */
export type TasksAutomationsEnableInput = {
  id: string;
};

/** Return shape for `tasks.automations.enable`. (no @Returns declared) */
export type TasksAutomationsEnableReturn = unknown;

/** Input shape for `tasks.automations.list`. */
export type TasksAutomationsListInput = Record<string, never>;

/** Return shape for `tasks.automations.list`. (no @Returns declared) */
export type TasksAutomationsListReturn = unknown;

/** Input shape for `tasks.automations.rm`. */
export type TasksAutomationsRmInput = {
  id: string;
};

/** Return shape for `tasks.automations.rm`. (no @Returns declared) */
export type TasksAutomationsRmReturn = unknown;

/** Input shape for `tasks.automations.show`. */
export type TasksAutomationsShowInput = {
  id: string;
};

/** Return shape for `tasks.automations.show`. (no @Returns declared) */
export type TasksAutomationsShowReturn = unknown;

/** Input shape for `tasks.block`. */
export type TasksBlockInput = {
  reason?: string;
  taskId: string;
};

/** Return shape for `tasks.block`. (no @Returns declared) */
export type TasksBlockReturn = unknown;

/** Input shape for `tasks.comment`. */
export type TasksCommentInput = {
  body: string;
  taskId: string;
};

/** Return shape for `tasks.comment`. (no @Returns declared) */
export type TasksCommentReturn = unknown;

/** Input shape for `tasks.create`. */
export type TasksCreateInput = {
  agent?: string;
  assignee?: string;
  checkpoint?: string;
  dependsOn?: string[];
  effort?: string;
  input?: string[];
  instructions?: string;
  model?: string;
  parent?: string;
  priority?: string;
  profile?: string;
  reportEvents?: string;
  reportTo?: string;
  session?: string;
  thinking?: string;
  title: string;
  worktreeBranch?: string;
  worktreeMode?: string;
  worktreePath?: string;
};

/** Return shape for `tasks.create`. (no @Returns declared) */
export type TasksCreateReturn = unknown;

/** Input shape for `tasks.deps.add`. */
export type TasksDepsAddInput = {
  dependencyTaskId: string;
  taskId: string;
};

/** Return shape for `tasks.deps.add`. (no @Returns declared) */
export type TasksDepsAddReturn = unknown;

/** Input shape for `tasks.deps.ls`. */
export type TasksDepsLsInput = {
  taskId: string;
};

/** Return shape for `tasks.deps.ls`. (no @Returns declared) */
export type TasksDepsLsReturn = unknown;

/** Input shape for `tasks.deps.rm`. */
export type TasksDepsRmInput = {
  dependencyTaskId: string;
  taskId: string;
};

/** Return shape for `tasks.deps.rm`. (no @Returns declared) */
export type TasksDepsRmReturn = unknown;

/** Input shape for `tasks.dispatch`. */
export type TasksDispatchInput = {
  agent?: string;
  checkpoint?: string;
  effort?: string;
  model?: string;
  reportEvents?: string;
  reportTo?: string;
  session?: string;
  taskId: string;
  thinking?: string;
};

/** Return shape for `tasks.dispatch`. (no @Returns declared) */
export type TasksDispatchReturn = unknown;

/** Input shape for `tasks.done`. */
export type TasksDoneInput = {
  summary?: string;
  taskId: string;
};

/** Return shape for `tasks.done`. (no @Returns declared) */
export type TasksDoneReturn = unknown;

/** Input shape for `tasks.fail`. */
export type TasksFailInput = {
  reason?: string;
  taskId: string;
};

/** Return shape for `tasks.fail`. (no @Returns declared) */
export type TasksFailReturn = unknown;

/** Input shape for `tasks.list`. */
export type TasksListInput = {
  agent?: string;
  all?: boolean;
  archived?: boolean;
  last?: string;
  mine?: boolean;
  parent?: string;
  profile?: string;
  root?: string;
  roots?: boolean;
  session?: string;
  status?: string;
  text?: string;
};

/** Return shape for `tasks.list`. (no @Returns declared) */
export type TasksListReturn = unknown;

/** Input shape for `tasks.profiles.init`. */
export type TasksProfilesInitInput = {
  preset?: string;
  profileId: string;
  source?: string;
};

/** Return shape for `tasks.profiles.init`. (no @Returns declared) */
export type TasksProfilesInitReturn = unknown;

/** Input shape for `tasks.profiles.list`. */
export type TasksProfilesListInput = Record<string, never>;

/** Return shape for `tasks.profiles.list`. (no @Returns declared) */
export type TasksProfilesListReturn = unknown;

/** Input shape for `tasks.profiles.preview`. */
export type TasksProfilesPreviewInput = {
  agent?: string;
  input?: string[];
  instructions?: string;
  profileId: string;
  session?: string;
  title?: string;
  worktreeBranch?: string;
  worktreeMode?: string;
  worktreePath?: string;
};

/** Return shape for `tasks.profiles.preview`. (no @Returns declared) */
export type TasksProfilesPreviewReturn = unknown;

/** Input shape for `tasks.profiles.show`. */
export type TasksProfilesShowInput = {
  profileId: string;
};

/** Return shape for `tasks.profiles.show`. (no @Returns declared) */
export type TasksProfilesShowReturn = unknown;

/** Input shape for `tasks.profiles.validate`. */
export type TasksProfilesValidateInput = {
  profileId?: string;
};

/** Return shape for `tasks.profiles.validate`. (no @Returns declared) */
export type TasksProfilesValidateReturn = unknown;

/** Input shape for `tasks.report`. */
export type TasksReportInput = {
  message?: string;
  progress?: string;
  taskId: string;
};

/** Return shape for `tasks.report`. (no @Returns declared) */
export type TasksReportReturn = unknown;

/** Input shape for `tasks.show`. */
export type TasksShowInput = {
  last?: string;
  taskId: string;
};

/** Return shape for `tasks.show`. (no @Returns declared) */
export type TasksShowReturn = unknown;

/** Input shape for `tasks.unarchive`. */
export type TasksUnarchiveInput = {
  taskId: string;
};

/** Return shape for `tasks.unarchive`. (no @Returns declared) */
export type TasksUnarchiveReturn = unknown;

/** Input shape for `tasks.watch`. */
export type TasksWatchInput = {
  taskId?: string;
};

/** Return shape for `tasks.watch`. (no @Returns declared) */
export type TasksWatchReturn = unknown;

/** Input shape for `tmux.attach`. */
export type TmuxAttachInput = {
  agent: string;
  session?: string;
};

/** Return shape for `tmux.attach`. (no @Returns declared) */
export type TmuxAttachReturn = unknown;

/** Input shape for `tmux.list`. */
export type TmuxListInput = Record<string, never>;

/** Return shape for `tmux.list`. (no @Returns declared) */
export type TmuxListReturn = unknown;

/** Input shape for `tmux.open`. */
export type TmuxOpenInput = {
  agent: string;
  session?: string;
};

/** Return shape for `tmux.open`. (no @Returns declared) */
export type TmuxOpenReturn = unknown;

/** Input shape for `tmux.watch`. */
export type TmuxWatchInput = {
  sync?: boolean;
};

/** Return shape for `tmux.watch`. (no @Returns declared) */
export type TmuxWatchReturn = unknown;

/** Input shape for `tools.list`. */
export type ToolsListInput = Record<string, never>;

/** Return shape for `tools.list`. (no @Returns declared) */
export type ToolsListReturn = unknown;

/** Input shape for `tools.manifest`. */
export type ToolsManifestInput = Record<string, never>;

/** Return shape for `tools.manifest`. (no @Returns declared) */
export type ToolsManifestReturn = unknown;

/** Input shape for `tools.schema`. */
export type ToolsSchemaInput = Record<string, never>;

/** Return shape for `tools.schema`. (no @Returns declared) */
export type ToolsSchemaReturn = unknown;

/** Input shape for `tools.show`. */
export type ToolsShowInput = {
  name: string;
};

/** Return shape for `tools.show`. (no @Returns declared) */
export type ToolsShowReturn = unknown;

/** Input shape for `tools.test`. */
export type ToolsTestInput = {
  args?: string;
  name: string;
};

/** Return shape for `tools.test`. (no @Returns declared) */
export type ToolsTestReturn = unknown;

/** Input shape for `transcribe.file`. */
export type TranscribeFileInput = {
  lang?: string;
  path: string;
};

/** Return shape for `transcribe.file`. (no @Returns declared) */
export type TranscribeFileReturn = unknown;

/** Input shape for `triggers.add`. */
export type TriggersAddInput = {
  account?: string;
  agent?: string;
  cooldown?: string;
  filter?: string;
  message?: string;
  name: string;
  session?: string;
  topic?: string;
};

/** Return shape for `triggers.add`. (no @Returns declared) */
export type TriggersAddReturn = unknown;

/** Input shape for `triggers.disable`. */
export type TriggersDisableInput = {
  id: string;
};

/** Return shape for `triggers.disable`. (no @Returns declared) */
export type TriggersDisableReturn = unknown;

/** Input shape for `triggers.enable`. */
export type TriggersEnableInput = {
  id: string;
};

/** Return shape for `triggers.enable`. (no @Returns declared) */
export type TriggersEnableReturn = unknown;

/** Input shape for `triggers.list`. */
export type TriggersListInput = Record<string, never>;

/** Return shape for `triggers.list`. (no @Returns declared) */
export type TriggersListReturn = unknown;

/** Input shape for `triggers.rm`. */
export type TriggersRmInput = {
  id: string;
};

/** Return shape for `triggers.rm`. (no @Returns declared) */
export type TriggersRmReturn = unknown;

/** Input shape for `triggers.set`. */
export type TriggersSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `triggers.set`. (no @Returns declared) */
export type TriggersSetReturn = unknown;

/** Input shape for `triggers.show`. */
export type TriggersShowInput = {
  id: string;
};

/** Return shape for `triggers.show`. (no @Returns declared) */
export type TriggersShowReturn = unknown;

/** Input shape for `triggers.test`. */
export type TriggersTestInput = {
  id: string;
};

/** Return shape for `triggers.test`. (no @Returns declared) */
export type TriggersTestReturn = unknown;

/** Input shape for `video.analyze`. */
export type VideoAnalyzeInput = {
  output?: string;
  prompt?: string;
  url: string;
};

/** Return shape for `video.analyze`. (no @Returns declared) */
export type VideoAnalyzeReturn = unknown;

/** Input shape for `whatsapp.dm.ack`. */
export type WhatsappDmAckInput = {
  account?: string;
  contact: string;
  messageId: string;
};

/** Return shape for `whatsapp.dm.ack`. (no @Returns declared) */
export type WhatsappDmAckReturn = unknown;

/** Input shape for `whatsapp.dm.read`. */
export type WhatsappDmReadInput = {
  account?: string;
  contact: string;
  last?: string;
  noAck?: boolean;
};

/** Return shape for `whatsapp.dm.read`. (no @Returns declared) */
export type WhatsappDmReadReturn = unknown;

/** Input shape for `whatsapp.dm.send`. */
export type WhatsappDmSendInput = {
  account?: string;
  contact: string;
  message: string;
};

/** Return shape for `whatsapp.dm.send`. (no @Returns declared) */
export type WhatsappDmSendReturn = unknown;

/** Input shape for `whatsapp.group.add`. */
export type WhatsappGroupAddInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.add`. (no @Returns declared) */
export type WhatsappGroupAddReturn = unknown;

/** Input shape for `whatsapp.group.create`. */
export type WhatsappGroupCreateInput = {
  account?: string;
  agent?: string;
  name: string;
  participants: string;
};

/** Return shape for `whatsapp.group.create`. (no @Returns declared) */
export type WhatsappGroupCreateReturn = unknown;

/** Input shape for `whatsapp.group.demote`. */
export type WhatsappGroupDemoteInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.demote`. (no @Returns declared) */
export type WhatsappGroupDemoteReturn = unknown;

/** Input shape for `whatsapp.group.description`. */
export type WhatsappGroupDescriptionInput = {
  account?: string;
  groupId: string;
  text: string;
};

/** Return shape for `whatsapp.group.description`. (no @Returns declared) */
export type WhatsappGroupDescriptionReturn = unknown;

/** Input shape for `whatsapp.group.info`. */
export type WhatsappGroupInfoInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.info`. (no @Returns declared) */
export type WhatsappGroupInfoReturn = unknown;

/** Input shape for `whatsapp.group.invite`. */
export type WhatsappGroupInviteInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.invite`. (no @Returns declared) */
export type WhatsappGroupInviteReturn = unknown;

/** Input shape for `whatsapp.group.join`. */
export type WhatsappGroupJoinInput = {
  account?: string;
  code: string;
};

/** Return shape for `whatsapp.group.join`. (no @Returns declared) */
export type WhatsappGroupJoinReturn = unknown;

/** Input shape for `whatsapp.group.leave`. */
export type WhatsappGroupLeaveInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.leave`. (no @Returns declared) */
export type WhatsappGroupLeaveReturn = unknown;

/** Input shape for `whatsapp.group.list`. */
export type WhatsappGroupListInput = {
  account?: string;
};

/** Return shape for `whatsapp.group.list`. (no @Returns declared) */
export type WhatsappGroupListReturn = unknown;

/** Input shape for `whatsapp.group.promote`. */
export type WhatsappGroupPromoteInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.promote`. (no @Returns declared) */
export type WhatsappGroupPromoteReturn = unknown;

/** Input shape for `whatsapp.group.remove`. */
export type WhatsappGroupRemoveInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.remove`. (no @Returns declared) */
export type WhatsappGroupRemoveReturn = unknown;

/** Input shape for `whatsapp.group.rename`. */
export type WhatsappGroupRenameInput = {
  account?: string;
  groupId: string;
  name: string;
};

/** Return shape for `whatsapp.group.rename`. (no @Returns declared) */
export type WhatsappGroupRenameReturn = unknown;

/** Input shape for `whatsapp.group.revoke-invite`. */
export type WhatsappGroupRevokeInviteInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.revoke-invite`. (no @Returns declared) */
export type WhatsappGroupRevokeInviteReturn = unknown;

/** Input shape for `whatsapp.group.settings`. */
export type WhatsappGroupSettingsInput = {
  account?: string;
  groupId: string;
  setting: string;
};

/** Return shape for `whatsapp.group.settings`. (no @Returns declared) */
export type WhatsappGroupSettingsReturn = unknown;

/** Input shape for `workflows.runs.archive-node`. */
export type WorkflowsRunsArchiveNodeInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.archive-node`. (no @Returns declared) */
export type WorkflowsRunsArchiveNodeReturn = unknown;

/** Input shape for `workflows.runs.cancel`. */
export type WorkflowsRunsCancelInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.cancel`. (no @Returns declared) */
export type WorkflowsRunsCancelReturn = unknown;

/** Input shape for `workflows.runs.list`. */
export type WorkflowsRunsListInput = Record<string, never>;

/** Return shape for `workflows.runs.list`. (no @Returns declared) */
export type WorkflowsRunsListReturn = unknown;

/** Input shape for `workflows.runs.release`. */
export type WorkflowsRunsReleaseInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.release`. (no @Returns declared) */
export type WorkflowsRunsReleaseReturn = unknown;

/** Input shape for `workflows.runs.show`. */
export type WorkflowsRunsShowInput = {
  runId: string;
};

/** Return shape for `workflows.runs.show`. (no @Returns declared) */
export type WorkflowsRunsShowReturn = unknown;

/** Input shape for `workflows.runs.skip`. */
export type WorkflowsRunsSkipInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.skip`. (no @Returns declared) */
export type WorkflowsRunsSkipReturn = unknown;

/** Input shape for `workflows.runs.start`. */
export type WorkflowsRunsStartInput = {
  runId?: string;
  specId: string;
};

/** Return shape for `workflows.runs.start`. (no @Returns declared) */
export type WorkflowsRunsStartReturn = unknown;

/** Input shape for `workflows.runs.task-attach`. */
export type WorkflowsRunsTaskAttachInput = {
  nodeKey: string;
  runId: string;
  taskId: string;
};

/** Return shape for `workflows.runs.task-attach`. (no @Returns declared) */
export type WorkflowsRunsTaskAttachReturn = unknown;

/** Input shape for `workflows.runs.task-create`. */
export type WorkflowsRunsTaskCreateInput = {
  agent?: string;
  instructions?: string;
  nodeKey: string;
  priority?: string;
  profile?: string;
  runId: string;
  session?: string;
  title?: string;
};

/** Return shape for `workflows.runs.task-create`. (no @Returns declared) */
export type WorkflowsRunsTaskCreateReturn = unknown;

/** Input shape for `workflows.specs.create`. */
export type WorkflowsSpecsCreateInput = {
  definition?: string;
  file?: string;
  specId: string;
};

/** Return shape for `workflows.specs.create`. (no @Returns declared) */
export type WorkflowsSpecsCreateReturn = unknown;

/** Input shape for `workflows.specs.list`. */
export type WorkflowsSpecsListInput = Record<string, never>;

/** Return shape for `workflows.specs.list`. (no @Returns declared) */
export type WorkflowsSpecsListReturn = unknown;

/** Input shape for `workflows.specs.show`. */
export type WorkflowsSpecsShowInput = {
  specId: string;
};

/** Return shape for `workflows.specs.show`. (no @Returns declared) */
export type WorkflowsSpecsShowReturn = unknown;
