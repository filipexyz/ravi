import type { ArtifactRecord } from "./store.js";

export type ArtifactNotificationTone = "pending" | "running" | "completed" | "failed" | "archived";

export interface ArtifactNotificationUiSpec {
  schema: "ravi.ui/v1";
  kind: "ui.spec";
  component: "artifact.notification";
  key: string;
  props: {
    artifactId: string;
    title: string;
    subtitle: string;
    summary: string | null;
    tone: ArtifactNotificationTone;
    kind: string;
    status: string;
    provider: string | null;
    model: string | null;
    sessionName: string | null;
    sessionKey: string | null;
    agentId: string | null;
    taskId: string | null;
    updatedAt: number;
  };
  actions: Array<{
    id: string;
    label: string;
    command: string;
    payload: Record<string, string>;
  }>;
}

export function buildArtifactNotificationUiSpec(input: {
  artifact: Pick<
    ArtifactRecord,
    | "id"
    | "kind"
    | "title"
    | "summary"
    | "status"
    | "provider"
    | "model"
    | "sessionName"
    | "sessionKey"
    | "agentId"
    | "taskId"
    | "updatedAt"
  >;
  lifecycle: ArtifactNotificationTone;
}): ArtifactNotificationUiSpec {
  const artifact = input.artifact;
  const title = cleanText(artifact.title) || artifact.kind || artifact.id;
  const subtitle = [artifact.kind, input.lifecycle, artifact.provider, artifact.model]
    .filter((value) => cleanText(value))
    .join(" · ");

  const actions: ArtifactNotificationUiSpec["actions"] = [
    {
      id: "open-artifact",
      label: "abrir",
      command: "overlay.artifacts.open",
      payload: { artifactId: artifact.id },
    },
  ];

  if (artifact.taskId) {
    actions.push({
      id: "open-task",
      label: "task",
      command: "overlay.tasks.open",
      payload: { taskId: artifact.taskId },
    });
  }

  const sessionKey = artifact.sessionKey || artifact.sessionName || null;
  if (sessionKey) {
    actions.push({
      id: "open-session",
      label: "sessao",
      command: "overlay.sessions.open",
      payload: { sessionKey },
    });
  }

  return {
    schema: "ravi.ui/v1",
    kind: "ui.spec",
    component: "artifact.notification",
    key: `artifact.notification:${artifact.id}:${input.lifecycle}:${artifact.updatedAt}`,
    props: {
      artifactId: artifact.id,
      title,
      subtitle,
      summary: cleanText(artifact.summary),
      tone: input.lifecycle,
      kind: artifact.kind,
      status: artifact.status,
      provider: cleanText(artifact.provider),
      model: cleanText(artifact.model),
      sessionName: cleanText(artifact.sessionName),
      sessionKey: cleanText(artifact.sessionKey),
      agentId: cleanText(artifact.agentId),
      taskId: cleanText(artifact.taskId),
      updatedAt: artifact.updatedAt,
    },
    actions,
  };
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
