/** @jsxImportSource @opentui/react */

export interface CockpitViewProps {
  title?: string;
  status?: CockpitStatusSnapshot;
  lanes?: CockpitLanesSnapshot;
  actions?: CockpitActionsSnapshot;
  activity?: CockpitActivitySnapshot;
}

export interface CockpitStatusSnapshot {
  daemon?: string;
  runtime?: string;
  channel?: string;
  activity?: string;
  alerts?: string[];
  session?: string;
}

export interface CockpitLanesSnapshot {
  totalSessions?: number;
  recentSessions?: number;
  queuedSessions?: number;
  blockedSessions?: number;
  ephemeralSessions?: number;
  focusSession?: string;
}

export interface CockpitActionsSnapshot {
  items: CockpitActionItem[];
}

export interface CockpitActionItem {
  id: string;
  label: string;
  trigger: string;
  enabled?: boolean;
}

export interface CockpitActivitySnapshot {
  feed: string[];
}

interface CockpitPanelProps {
  title: string;
  accent: "cyan" | "yellow" | "green" | "magenta";
  width?: string;
  children: any;
}

function CockpitPanel({ title, accent, width = "100%", children }: CockpitPanelProps) {
  return (
    <box border borderColor={accent} flexDirection="column" width={width} height="100%" padding={1}>
      <text content={title} fg={accent} bold />
      <box height={1} />
      {children}
    </box>
  );
}

function PlaceholderLine({
  label,
  value,
  tone = "gray",
}: {
  label: string;
  value: string;
  tone?: "gray" | "white" | "cyan" | "yellow" | "green";
}) {
  return (
    <box flexDirection="row" width="100%">
      <text content={`${label}: `} fg="white" />
      <text content={value} fg={tone} />
    </box>
  );
}

export function CockpitView({ title = "Ravi Cockpit v0", status, lanes, actions, activity }: CockpitViewProps) {
  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <box flexDirection="column" width="100%" marginBottom={1}>
        <text content={title} fg="cyan" bold />
        <text content="Minimal operator shell. Wire live data, commands, and navigation next." fg="gray" />
      </box>

      <box flexDirection="row" width="100%" height={11} marginBottom={1}>
        <box width="33%" height="100%" paddingRight={1}>
          <CockpitPanel title="Status" accent="cyan">
            <StatusPanel status={status} />
          </CockpitPanel>
        </box>

        <box width="34%" height="100%" paddingX={1}>
          <CockpitPanel title="Lanes" accent="yellow">
            <LanesPanel lanes={lanes} />
          </CockpitPanel>
        </box>

        <box width="33%" height="100%" paddingLeft={1}>
          <CockpitPanel title="Actions" accent="green">
            <ActionsPanel actions={actions} />
          </CockpitPanel>
        </box>
      </box>

      <CockpitPanel title="Activity" accent="magenta">
        <ActivityPanel activity={activity} />
      </CockpitPanel>
    </box>
  );
}

function StatusPanel({ status }: { status?: CockpitStatusSnapshot }) {
  const alerts = status?.alerts ?? [];
  const alertsValue = alerts.length > 0 ? alerts.join(" | ") : "none";

  return (
    <>
      <PlaceholderLine
        label="Daemon"
        value={status?.daemon ?? "[daemon status placeholder]"}
        tone={status?.daemon ? (status.daemon.startsWith("reachable") ? "green" : "yellow") : "gray"}
      />
      <PlaceholderLine
        label="Runtime"
        value={status?.runtime ?? "[runtime placeholder]"}
        tone={status?.runtime ? "cyan" : "gray"}
      />
      <PlaceholderLine
        label="Channel"
        value={status?.channel ?? "[channel placeholder]"}
        tone={status?.channel ? "white" : "gray"}
      />
      <PlaceholderLine
        label="Activity"
        value={status?.activity ?? "[activity placeholder]"}
        tone={status?.activity ? "yellow" : "gray"}
      />
      <PlaceholderLine
        label="Session"
        value={status?.session ?? "[session placeholder]"}
        tone={status?.session ? "white" : "gray"}
      />
      <PlaceholderLine label="Alerts" value={alertsValue} tone={alerts.length > 0 ? "yellow" : "green"} />
    </>
  );
}

function LanesPanel({ lanes }: { lanes?: CockpitLanesSnapshot }) {
  return (
    <>
      <PlaceholderLine
        label="Sessions"
        value={lanes?.totalSessions !== undefined ? String(lanes.totalSessions) : "[sessions placeholder]"}
        tone={lanes?.totalSessions !== undefined ? "white" : "gray"}
      />
      <PlaceholderLine
        label="Recent 15m"
        value={lanes?.recentSessions !== undefined ? String(lanes.recentSessions) : "[recent placeholder]"}
        tone={lanes?.recentSessions !== undefined ? "cyan" : "gray"}
      />
      <PlaceholderLine
        label="Queued"
        value={lanes?.queuedSessions !== undefined ? String(lanes.queuedSessions) : "[queue placeholder]"}
        tone={lanes?.queuedSessions !== undefined ? "yellow" : "gray"}
      />
      <PlaceholderLine
        label="Blocked"
        value={lanes?.blockedSessions !== undefined ? String(lanes.blockedSessions) : "[blocked placeholder]"}
        tone={lanes?.blockedSessions !== undefined ? "yellow" : "gray"}
      />
      <PlaceholderLine
        label="Ephemeral"
        value={lanes?.ephemeralSessions !== undefined ? String(lanes.ephemeralSessions) : "[ephemeral placeholder]"}
        tone={lanes?.ephemeralSessions !== undefined ? "green" : "gray"}
      />
      <PlaceholderLine
        label="Focus"
        value={lanes?.focusSession ?? "[focus session placeholder]"}
        tone={lanes?.focusSession ? "white" : "gray"}
      />
    </>
  );
}

function ActionsPanel({ actions }: { actions?: CockpitActionsSnapshot }) {
  const items = actions?.items ?? [];
  const placeholders = Math.max(0, 5 - items.length);
  const placeholderSlots = Array.from({ length: placeholders }, (_, offset) => String(items.length + offset + 1));

  return (
    <>
      {items.map((action) => (
        <PlaceholderLine
          key={action.id}
          label={action.label}
          value={action.trigger}
          tone={action.enabled === false ? "gray" : "green"}
        />
      ))}
      {placeholderSlots.map((slotLabel) => (
        <PlaceholderLine key={`placeholder-${slotLabel}`} label={slotLabel} value="[action placeholder]" />
      ))}
    </>
  );
}

function ActivityPanel({ activity }: { activity?: CockpitActivitySnapshot }) {
  const feed = activity?.feed ?? [];

  if (feed.length === 0) {
    return <PlaceholderLine label="Feed" value="[activity feed placeholder]" />;
  }

  return (
    <box flexDirection="column" width="100%">
      {feed.map((line, index) => (
        <text
          key={`${index}-${line}`}
          content={` ${index + 1}. ${line}`}
          fg={index === feed.length - 1 ? "cyan" : "white"}
        />
      ))}
    </box>
  );
}
