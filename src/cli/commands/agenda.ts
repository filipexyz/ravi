import "reflect-metadata";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { CloudAuthError, isCloudAuthError } from "../../cloud-auth/errors.js";
import {
  CALENDAR_BRIEFING_MAX_CHARS,
  CALENDAR_RECORD_MODES,
  consoleMeetingUrl,
  requireCalendarConsoleClient,
  type CalendarConsoleClient,
  type CalendarConsoleClientDeps,
  type CalendarRecordMode,
  type ConsoleCalendarConnection,
  type ConsoleCalendarEvent,
  type ConsoleCalendarOverview,
  type ConsoleCalendarSettingsPatch,
} from "../../calendar/console.js";
import type { ConnectorTurnDeps } from "../../link/connector-turn.js";
import { meetingReadTurnBlock } from "../../meetings/read.js";
import {
  ContractError,
  CONTRACT_EXIT_ERROR,
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  contractDryRun,
  contractFail,
  renderContractError,
} from "../agent-contract.js";
import { cloudErrorToContractError } from "../cloud-error-contract.js";
import { getContextValue } from "../context.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { strictCliOffsetPaginationSchema } from "../return-schemas.js";

// `ravi agenda`: the operator's calendar as the Ravi Console keeps it, their
// recording settings and the briefing of each meeting. Every command runs
// with the operator's own login, so only the operator's own turns (terminal,
// their direct chat, their routines) may use it; a group is refused too,
// because the answer would show their calendar to everyone in it.

const DEFAULT_LIST_DAYS = 7;
const MAX_LIST_DAYS = 30;
const LIST_LOOKBACK_MS = 3600 * 1000;

export interface AgendaCommandDeps {
  calendar?: CalendarConsoleClientDeps & {
    turn?: ConnectorTurnDeps;
    /** Overrides the turn classification (tests): true = the operator's own turn. */
    operatorTurn?: boolean;
  };
}

const nullableString = z.string().nullable();
const recordModeSchema = z.enum(CALENDAR_RECORD_MODES).nullable();
const agendaEventSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  title: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  allDay: z.boolean(),
  status: z.string(),
  meetingUrl: nullableString,
  meetingCode: nullableString,
  organizerEmail: nullableString.optional(),
  selfResponse: nullableString.optional(),
  attendees: z.array(
    z.object({
      email: z.string(),
      name: nullableString,
      response: nullableString,
      organizer: z.boolean(),
      self: z.boolean(),
    }),
  ),
  externalAttendees: z.boolean(),
  recurringEventId: nullableString.optional(),
  recordDecision: z.enum(["record", "skip"]).nullable(),
  recordDecisionProjectId: nullableString.optional(),
  recordError: nullableString.optional(),
  effectiveRecordMode: recordModeSchema,
  briefingEnabled: z.boolean().nullable().optional(),
  briefingMinutes: z.number().optional(),
  followupEnabled: z.boolean().nullable().optional(),
  recording: z
    .object({ meetingId: z.string(), status: z.string(), ready: z.boolean(), projectId: nullableString })
    .nullable(),
  hasBriefing: z.boolean().optional(),
  updatedAt: z.string().optional(),
  deletedAt: nullableString.optional(),
  /** `show` and the write commands: the operator's own briefing. */
  briefing: nullableString.optional(),
  /** `show`: the recording's page in the Console. */
  consoleMeetingUrl: nullableString.optional(),
});
const agendaConnectionSchema = z.object({
  connectionId: z.string(),
  email: nullableString,
  displayName: nullableString,
  hasCalendarScope: z.boolean(),
  settings: z.object({
    syncEnabled: z.boolean(),
    recordMode: recordModeSchema,
    projectId: nullableString,
    briefingEnabled: z.boolean().nullable(),
    briefingMinutes: z.number(),
    followupEnabled: z.boolean().nullable(),
  }),
  lastSyncedAt: nullableString,
  lastSyncError: nullableString,
});
const agendaStatusReturnSchema = z.object({
  connections: z.array(agendaConnectionSchema),
  policy: z.object({ autoRecordAllowed: z.boolean(), canManage: z.boolean() }),
  meetingsEnabled: z.boolean(),
  projects: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
});
const agendaSettingsReturnSchema = z.object({ connection: agendaConnectionSchema });
const agendaListReturnSchema = z.object({
  from: z.string(),
  to: z.string(),
  truncated: z.boolean(),
  total: z.number(),
  pagination: strictCliOffsetPaginationSchema,
  events: z.array(agendaEventSchema),
});
const agendaEventReturnSchema = z.object({ event: agendaEventSchema });

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

@Group({
  name: "agenda",
  description: "The operator's calendar in the Ravi Console: meetings, recording and briefings",
  scope: "open",
})
export class AgendaCommands {
  constructor(private readonly deps: AgendaCommandDeps = {}) {}

  @Command({ name: "status", description: "Show the calendar connections, their settings and the projects" })
  @CommandAccess({ kind: "read", resource: "agenda", action: "status", risk: "medium" })
  @Returns(agendaStatusReturnSchema)
  async status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const op = "agenda status";
    return this.withAgenda(op, asJson, async (client) => {
      const overview = await client.overview();
      if (asJson) printJson(overview);
      else printOverview(overview);
      return overview;
    });
  }

  // Declared UNBRAKED except `--record auto`: every other change is the
  // operator's own reversible setting. Automatic recording sends a bot into
  // calls nobody confirmed one by one, so it waits for --execute.
  @Command({ name: "settings", description: "Change how a calendar is used: sync, recording, project, briefing" })
  @CommandAccess({ kind: "mutate", resource: "agenda", action: "settings", risk: "medium", requiresConfirmation: true })
  @Returns(agendaSettingsReturnSchema)
  async settings(
    @Option({ flags: "--connection <id>", description: "Google connection id (default: the only one)" })
    connection?: string,
    @Option({ flags: "--sync <on|off>", description: "Use this calendar" }) sync?: string,
    @Option({ flags: "--record <mode>", description: "Record calls: ask, auto or off" }) record?: string,
    @Option({ flags: "--project <ref>", description: "Project id or slug where recordings go" }) project?: string,
    @Option({ flags: "--briefing <on|off>", description: "Prepare a briefing before each meeting" })
    briefing?: string,
    @Option({ flags: "--briefing-minutes <n>", description: "How long before the start (5-240)" })
    briefingMinutes?: string,
    @Option({ flags: "--followup <on|off>", description: "Run the follow-up when the recording is ready" })
    followup?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Apply --record auto (dry-run without it)" }) execute?: boolean,
  ) {
    const op = "agenda settings";
    return this.withAgenda(op, asJson, async (client) => {
      const overview = await client.overview();
      const target = pickConnection(op, overview, connection, asJson);
      const patch: ConsoleCalendarSettingsPatch = { connectionId: target.connectionId };
      if (sync !== undefined) patch.syncEnabled = parseSwitch(op, "--sync", sync, asJson);
      if (record !== undefined) patch.recordMode = parseRecordMode(op, record, asJson);
      if (project !== undefined) patch.projectId = resolveProject(op, overview, project, asJson);
      if (briefing !== undefined) patch.briefingEnabled = parseSwitch(op, "--briefing", briefing, asJson);
      if (briefingMinutes !== undefined) patch.briefingMinutes = parseMinutes(op, briefingMinutes, asJson);
      if (followup !== undefined) patch.followupEnabled = parseSwitch(op, "--followup", followup, asJson);
      if (Object.keys(patch).length === 1) {
        usage(
          op,
          "Nothing to change. Pass at least one of --sync, --record, --project, --briefing, --briefing-minutes or --followup.",
          asJson,
        );
      }
      const recordMode = patch.recordMode ?? target.settings.recordMode;
      const projectId = patch.projectId !== undefined ? patch.projectId : target.settings.projectId;
      if ((recordMode === "ask" || recordMode === "auto") && !projectId) {
        usage(
          op,
          `Recording needs a project. Pass --project with one of: ${overview.projects.map((entry) => entry.slug).join(", ") || "(no project you can write)"}.`,
          asJson,
        );
      }
      if (patch.recordMode === "auto" && target.settings.recordMode !== "auto") {
        if (!overview.policy.autoRecordAllowed) {
          contractFail(
            op,
            "POLICY_DISABLED",
            "The organization does not allow automatic recording of calendar calls.",
            {
              asJson,
              exitCode: CONTRACT_EXIT_POLICY,
              details: {
                suggestedAction:
                  "An owner or admin of the organization turns on automatic recording in the Console settings. Until then use --record ask.",
              },
            },
          );
        }
        if (!execute) contractDryRun(op, { ...patch }, { asJson });
      }
      const updated = await client.updateSettings(patch);
      const payload = { connection: updated };
      if (asJson) printJson(payload);
      else printConnection(updated);
      return payload;
    });
  }

  @Command({ name: "list", description: "List the next meetings on the operator's calendar" })
  @CommandAccess({ kind: "read", resource: "agenda", action: "list", risk: "medium" })
  @Returns(agendaListReturnSchema)
  async list(
    @Option({ flags: "--days <n>", description: `Days ahead (default ${DEFAULT_LIST_DAYS}, max ${MAX_LIST_DAYS})` })
    days?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of earlier meetings to skip (default: 0)" })
    offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "agenda list";
    const span = days === undefined ? DEFAULT_LIST_DAYS : Number(days);
    if (!Number.isInteger(span) || span < 1 || span > MAX_LIST_DAYS) {
      usage(op, `--days must be a whole number between 1 and ${MAX_LIST_DAYS}.`, asJson);
    }
    return this.withAgenda(op, asJson, async (client) => {
      const now = Date.now();
      const from = new Date(now - LIST_LOOKBACK_MS);
      const to = new Date(now + span * 24 * 3600 * 1000);
      const listed = await client.events({ from, to });
      const page = paginateCliItems(listed.events, { limit, offset }, { defaultLimit: 50, maxLimit: 500 });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "agenda", "list", ...(days !== undefined ? ["--days", days] : [])],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
      });
      const payload = {
        from: from.toISOString(),
        to: to.toISOString(),
        truncated: listed.truncated,
        total: page.total,
        pagination,
        events: page.items,
      };
      if (asJson) printJson(payload);
      else if (page.items.length === 0) console.log("No meetings in that window.");
      else for (const event of page.items) console.log(eventLine(event));
      return payload;
    });
  }

  @Command({ name: "show", description: "Show one calendar event with its briefing" })
  @CommandAccess({ kind: "read", resource: "agenda", action: "show", risk: "medium" })
  @Returns(agendaEventReturnSchema)
  async show(
    @Arg("eventId", { description: "Calendar event id (from agenda list)" }) eventId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "agenda show";
    return this.withAgenda(op, asJson, async (client) => {
      const event = await client.event(eventId);
      const payload = { event: { ...event, consoleMeetingUrl: consoleMeetingUrl(client.consoleUrl, event) } };
      if (asJson) printJson(payload);
      else {
        console.log(eventLine(event));
        const guests = event.attendees
          .filter((attendee) => !attendee.self)
          .map((attendee) => attendee.name ?? attendee.email);
        if (guests.length) console.log(`With: ${guests.join(", ")}`);
        if (event.meetingUrl) console.log(`Call: ${event.meetingUrl}`);
        if (payload.event.consoleMeetingUrl) console.log(`Recording: ${payload.event.consoleMeetingUrl}`);
        if (event.recordError) console.log(`Recording failed: ${event.recordError}`);
        if (event.briefing) console.log(`\n${event.briefing}`);
      }
      return payload;
    });
  }

  // BRAKED: recording sends the Ravi bot into a call with other people.
  @Command({ name: "record", description: "Record this meeting (the Console sends the bot at the start)" })
  @CommandAccess({ kind: "mutate", resource: "agenda", action: "record", risk: "high", requiresConfirmation: true })
  @Returns(agendaEventReturnSchema)
  async record(
    @Arg("eventId", { description: "Calendar event id (from agenda list)" }) eventId: string,
    @Option({ flags: "--project <ref>", description: "Project id or slug (default: the calendar's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Record (dry-run without it)" }) execute?: boolean,
  ) {
    const op = "agenda record";
    return this.withAgenda(op, asJson, async (client) => {
      const projectId =
        project === undefined ? undefined : resolveProject(op, await client.overview(), project, asJson);
      if (!execute) {
        const event = await client.event(eventId);
        contractDryRun(
          op,
          {
            eventId,
            title: event.title,
            startAt: event.startAt,
            meetingUrl: event.meetingUrl,
            externalAttendees: event.externalAttendees,
            decision: "record",
            ...(projectId ? { projectId } : {}),
          },
          { asJson },
        );
      }
      return this.decided(client, op, eventId, { decision: "record", ...(projectId ? { projectId } : {}) }, asJson);
    });
  }

  // Declared UNBRAKED: skipping only keeps a bot out of the call.
  @Command({ name: "skip", description: "Do not record this meeting" })
  @CommandAccess({ kind: "mutate", resource: "agenda", action: "skip", risk: "low" })
  @Returns(agendaEventReturnSchema)
  async skip(
    @Arg("eventId", { description: "Calendar event id (from agenda list)" }) eventId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.withAgenda("agenda skip", asJson, (client) =>
      this.decided(client, "agenda skip", eventId, { decision: "skip" }, asJson),
    );
  }

  // BRAKED only when undoing a skip under automatic recording: then the
  // meeting may be recorded without anyone asking again.
  @Command({ name: "undo", description: "Clear the record or skip decision of this meeting" })
  @CommandAccess({ kind: "mutate", resource: "agenda", action: "undo", risk: "medium", requiresConfirmation: true })
  @Returns(agendaEventReturnSchema)
  async undo(
    @Arg("eventId", { description: "Calendar event id (from agenda list)" }) eventId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Clear a skip under automatic recording" }) execute?: boolean,
  ) {
    const op = "agenda undo";
    return this.withAgenda(op, asJson, async (client) => {
      const event = await client.event(eventId);
      if (event.recordDecision === "skip" && event.effectiveRecordMode === "auto" && !execute) {
        contractDryRun(
          op,
          { eventId, title: event.title, startAt: event.startAt, decision: null, effect: "may record automatically" },
          { asJson },
        );
      }
      return this.decided(client, op, eventId, { decision: null }, asJson);
    });
  }

  // Declared UNBRAKED: the briefing is shown only to the operator.
  @Command({ name: "briefing", description: "Store the meeting's briefing (Markdown), shown on its Console page" })
  @CommandAccess({ kind: "mutate", resource: "agenda", action: "briefing", risk: "low" })
  @Returns(agendaEventReturnSchema)
  async briefing(
    @Arg("eventId", { description: "Calendar event id (from agenda list)" }) eventId: string,
    @Option({ flags: "--text <markdown>", description: "The briefing" }) text?: string,
    @Option({ flags: "--file <path>", description: "Read the briefing from a file" }) file?: string,
    @Option({ flags: "--clear", description: "Delete the briefing" }) clear?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "agenda briefing";
    const given = [text !== undefined, file !== undefined, clear === true].filter(Boolean).length;
    if (given !== 1) usage(op, "Pass exactly one of --text, --file or --clear.", asJson);
    return this.withAgenda(op, asJson, async (client) => {
      // The file is read only after the turn check, so another person's turn learns nothing about local files.
      let markdown = "";
      if (file !== undefined) markdown = readBriefingFile(op, file, asJson);
      else if (text !== undefined) markdown = text.replaceAll("\\n", "\n");
      if (!clear && !markdown.trim()) usage(op, "The briefing is empty. Use --clear to delete it.", asJson);
      if (markdown.length > CALENDAR_BRIEFING_MAX_CHARS) {
        usage(
          op,
          `The briefing has ${markdown.length} characters; the limit is ${CALENDAR_BRIEFING_MAX_CHARS}.`,
          asJson,
        );
      }
      const event = await client.setBriefing(eventId, clear ? "" : markdown);
      const payload = { event };
      if (asJson) printJson(payload);
      else console.log(clear ? `Briefing deleted: ${eventLine(event)}` : `Briefing saved: ${eventLine(event)}`);
      return payload;
    });
  }

  private async decided(
    client: CalendarConsoleClient,
    op: string,
    eventId: string,
    body: { decision: "record" | "skip" | null; projectId?: string },
    asJson: boolean | undefined,
  ) {
    const event = await client.decide(eventId, body);
    const payload = { event };
    if (asJson) printJson(payload);
    else
      console.log(
        `${op === "agenda undo" ? "Cleared" : body.decision === "record" ? "Recording" : "Not recording"}: ${eventLine(event)}`,
      );
    return payload;
  }

  /** Checks the turn, opens the Console client and renders Console failures once. */
  private async withAgenda<T>(
    op: string,
    asJson: boolean | undefined,
    run: (client: CalendarConsoleClient) => Promise<T>,
  ): Promise<T> {
    const deps = this.deps.calendar ?? {};
    const block = meetingReadTurnBlock({
      turn: deps.turn,
      readCredentials: deps.readCredentials,
      operatorTurn: deps.operatorTurn,
    });
    if (block) {
      contractFail(
        op,
        "CALENDAR_ACCESS_DENIED",
        `The calendar is used only on the operator's own turns (terminal, their direct chat, their routines). This turn is not the operator's own: ${block.why}.`,
        {
          asJson,
          exitCode: CONTRACT_EXIT_POLICY,
          details: {
            refusal: "operator_only",
            turn: block.turn,
            suggestedAction:
              "Tell the person you cannot look at or change the operator's calendar here; the operator can ask in their own chat.",
          },
        },
      );
    }
    try {
      return await run(requireCalendarConsoleClient(deps));
    } catch (error) {
      if (error instanceof ContractError || !isCloudAuthError(error)) throw error;
      const contract = calendarErrorToContract(op, error);
      renderContractError(contract, asJson);
      throw contract;
    }
  }
}

function calendarErrorToContract(op: string, error: CloudAuthError): ContractError {
  if (error.consoleCode === "POLICY_DISABLED") {
    return new ContractError(
      op,
      "POLICY_DISABLED",
      "The organization's policy does not allow this.",
      CONTRACT_EXIT_POLICY,
      {
        suggestedAction:
          "An owner or admin of the organization turns on automatic recording in the Console settings. Until then use --record ask.",
      },
    );
  }
  if (error.consoleCode === "CALENDAR_SCOPE_MISSING") {
    return new ContractError(
      op,
      "CALENDAR_SCOPE_MISSING",
      "This Google connection cannot read the calendar.",
      CONTRACT_EXIT_ERROR,
      { suggestedAction: "Ask the operator to reconnect Google with calendar access in the Console (Connectors)." },
    );
  }
  return cloudErrorToContractError(op, error);
}

function usage(op: string, message: string, asJson: boolean | undefined): never {
  contractFail(op, "INVALID_ARGUMENT", message, { asJson, exitCode: CONTRACT_EXIT_USAGE });
}

function parseSwitch(op: string, flag: string, value: string, asJson: boolean | undefined): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "off" || normalized === "false" || normalized === "no") return false;
  usage(op, `${flag} must be on or off.`, asJson);
}

function parseRecordMode(op: string, value: string, asJson: boolean | undefined): CalendarRecordMode {
  const normalized = value.trim().toLowerCase();
  if ((CALENDAR_RECORD_MODES as readonly string[]).includes(normalized)) return normalized as CalendarRecordMode;
  usage(op, `--record must be one of ${CALENDAR_RECORD_MODES.join(", ")}.`, asJson);
}

function parseMinutes(op: string, value: string, asJson: boolean | undefined): number {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) {
    usage(op, "--briefing-minutes must be a whole number between 5 and 240.", asJson);
  }
  return minutes;
}

function pickConnection(
  op: string,
  overview: ConsoleCalendarOverview,
  ref: string | undefined,
  asJson: boolean | undefined,
): ConsoleCalendarConnection {
  const wanted = ref?.trim();
  if (wanted) {
    const found = overview.connections.find(
      (entry) => entry.connectionId === wanted || entry.email?.toLowerCase() === wanted.toLowerCase(),
    );
    if (found) return found;
    contractFail(op, "CALENDAR_CONNECTION_NOT_FOUND", `No Google connection ${wanted} on this login.`, {
      asJson,
      details: { suggestions: overview.connections.slice(0, 3).map((entry) => entry.connectionId) },
    });
  }
  if (overview.connections.length === 1) return overview.connections[0];
  if (overview.connections.length === 0) {
    contractFail(op, "CALENDAR_CONNECTION_NOT_FOUND", "This login has no personal Google connection.", {
      asJson,
      details: {
        suggestedAction: "Ask the operator to connect Google (with calendar access) in the Console, under Connectors.",
      },
    });
  }
  usage(
    op,
    `Several Google connections; pass --connection with one of: ${overview.connections.map((entry) => entry.connectionId).join(", ")}.`,
    asJson,
  );
}

function resolveProject(
  op: string,
  overview: ConsoleCalendarOverview,
  ref: string,
  asJson: boolean | undefined,
): string {
  const wanted = ref.trim().toLowerCase();
  const found = overview.projects.find(
    (entry) => entry.id.toLowerCase() === wanted || entry.slug.toLowerCase() === wanted,
  );
  if (found) return found.id;
  usage(
    op,
    `Not a project this login can write: ${ref}. Use one of: ${overview.projects.map((entry) => entry.slug).join(", ") || "(none)"}.`,
    asJson,
  );
}

function readBriefingFile(op: string, path: string, asJson: boolean | undefined): string {
  // A gateway caller would read a file on the daemon's machine; it sends the text instead.
  if (getContextValue("transport") === "gateway") {
    usage(op, "--file is not available over the gateway. Pass the briefing with --text.", asJson);
  }
  try {
    if (statSync(path).size > CALENDAR_BRIEFING_MAX_CHARS * 4) {
      usage(op, `The file is larger than the ${CALENDAR_BRIEFING_MAX_CHARS}-character limit.`, asJson);
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof ContractError) throw error;
    usage(op, `Cannot read ${path}.`, asJson);
  }
}

function eventLine(event: ConsoleCalendarEvent): string {
  const state = event.recording
    ? `recording ${event.recording.status}`
    : event.recordDecision === "record"
      ? "will record"
      : event.recordDecision === "skip"
        ? "not recording"
        : event.effectiveRecordMode === "auto" && !event.externalAttendees
          ? "auto"
          : event.effectiveRecordMode === "off"
            ? "off"
            : "ask";
  return `${event.startAt}  ${event.title || "(no title)"}  [${event.meetingCode ? state : "no call link"}]  ${event.id}`;
}

function printConnection(connection: ConsoleCalendarConnection): void {
  const settings = connection.settings;
  console.log(`${connection.email ?? connection.connectionId} (${connection.connectionId})`);
  console.log(
    `  sync ${settings.syncEnabled ? "on" : "off"} · record ${settings.recordMode ?? "not chosen"} · project ${settings.projectId ?? "none"}`,
  );
  console.log(
    `  briefing ${settings.briefingEnabled ? `${settings.briefingMinutes} min before` : "off"} · follow-up ${settings.followupEnabled ? "on" : "off"}`,
  );
  if (!connection.hasCalendarScope) console.log("  cannot read the calendar: reconnect Google with calendar access");
  if (connection.lastSyncError) console.log(`  last sync failed: ${connection.lastSyncError}`);
}

function printOverview(overview: ConsoleCalendarOverview): void {
  if (overview.connections.length === 0) console.log("No personal Google connection.");
  for (const connection of overview.connections) printConnection(connection);
  console.log(`Automatic recording in the organization: ${overview.policy.autoRecordAllowed ? "allowed" : "off"}`);
  if (overview.projects.length) console.log(`Projects: ${overview.projects.map((entry) => entry.slug).join(", ")}`);
}
