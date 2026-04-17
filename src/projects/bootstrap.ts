import { createProject, getProjectDetails, linkProject } from "./service.js";
import type {
  ProjectBootstrapResourceInput,
  ProjectInitInput,
  ProjectInitResult,
  ProjectInitializedWorkflow,
  ProjectLink,
  ProjectWorkflowLinkRole,
  ProjectWorkflowTemplateId,
  ProjectWorkflowTemplateSummary,
  ProjectResourceType,
} from "./types.js";
import { createWorkflowSpec, getWorkflowRunDetails, getWorkflowSpec, startWorkflowRun } from "../workflows/index.js";
import type { CreateWorkflowSpecInput } from "../workflows/types.js";

const MAX_PROJECT_INIT_WORKFLOWS = 2;

interface CanonicalProjectWorkflowTemplate {
  id: ProjectWorkflowTemplateId;
  specId: string;
  spec: CreateWorkflowSpecInput;
  shape: string;
}

const PROJECT_WORKFLOW_TEMPLATE_ORDER: ProjectWorkflowTemplateId[] = [
  "technical-change",
  "gated-release",
  "operational-response",
];

const PROJECT_WORKFLOW_TEMPLATES: Record<ProjectWorkflowTemplateId, CanonicalProjectWorkflowTemplate> = {
  "technical-change": {
    id: "technical-change",
    specId: "wf-spec-canonical-technical-change-v1",
    shape: "implement -> review -> ship",
    spec: {
      title: "Technical Change Flow",
      summary: "Implement one technical change, review it, and ship it without manual gates.",
      policy: {
        completionMode: "all_required",
      },
      nodes: [
        {
          key: "implement",
          label: "Implement",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
        {
          key: "review",
          label: "Review",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
      edges: [
        { from: "implement", to: "review" },
        { from: "review", to: "ship" },
      ],
    },
  },
  "gated-release": {
    id: "gated-release",
    specId: "wf-spec-canonical-gated-release-v1",
    shape: "build -> checkpoint -> approval -> deploy",
    spec: {
      title: "Gated Release Flow",
      summary: "Build a release candidate, stop on a manual checkpoint, require explicit approval, then deploy.",
      policy: {
        completionMode: "all_required",
      },
      nodes: [
        {
          key: "build",
          label: "Build",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
        {
          key: "checkpoint",
          label: "Checkpoint",
          kind: "gate",
          requirement: "required",
          releaseMode: "manual",
        },
        {
          key: "approval",
          label: "Approval",
          kind: "approval",
          requirement: "required",
          releaseMode: "manual",
        },
        {
          key: "deploy",
          label: "Deploy",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
      edges: [
        { from: "build", to: "checkpoint" },
        { from: "checkpoint", to: "approval" },
        { from: "approval", to: "deploy" },
      ],
    },
  },
  "operational-response": {
    id: "operational-response",
    specId: "wf-spec-canonical-operational-response-v1",
    shape: "triage -> execute -> communicate",
    spec: {
      title: "Operational Response Flow",
      summary: "Triage one operational issue, execute the response, and communicate or close out the work.",
      policy: {
        completionMode: "all_required",
      },
      nodes: [
        {
          key: "triage",
          label: "Triage",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
        {
          key: "execute",
          label: "Execute",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
        {
          key: "communicate",
          label: "Communicate",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
      edges: [
        { from: "triage", to: "execute" },
        { from: "execute", to: "communicate" },
      ],
    },
  },
};

function normalizeList(values?: string[]): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeRole(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function defaultResourceRole(type: ProjectResourceType): string {
  switch (type) {
    case "worktree":
      return "substrate";
    case "repo":
      return "repo";
    case "group":
      return "group";
    case "contact":
      return "contact";
    default:
      return "reference";
  }
}

function buildResourceMetadata(resource: ProjectBootstrapResourceInput): Record<string, unknown> {
  return {
    ...(resource.metadata ?? {}),
    type: resource.type,
    ...(resource.label?.trim() ? { label: resource.label.trim() } : {}),
    locator: resource.assetId,
  };
}

function getTemplateDefinition(templateId: ProjectWorkflowTemplateId): CanonicalProjectWorkflowTemplate {
  return PROJECT_WORKFLOW_TEMPLATES[templateId];
}

export function requireProjectWorkflowTemplateId(value: string): ProjectWorkflowTemplateId {
  const normalized = value.trim().toLowerCase() as ProjectWorkflowTemplateId;
  if (!PROJECT_WORKFLOW_TEMPLATES[normalized]) {
    throw new Error(`Unknown workflow template: ${value}. Use ${PROJECT_WORKFLOW_TEMPLATE_ORDER.join("|")}.`);
  }
  return normalized;
}

export function listProjectWorkflowTemplates(): ProjectWorkflowTemplateSummary[] {
  return PROJECT_WORKFLOW_TEMPLATE_ORDER.map((templateId) => {
    const template = getTemplateDefinition(templateId);
    return {
      id: template.id,
      specId: template.specId,
      title: template.spec.title,
      summary: template.spec.summary ?? "",
      shape: template.shape,
      nodeCount: template.spec.nodes.length,
    };
  });
}

function ensureCanonicalWorkflowSpec(
  templateId: ProjectWorkflowTemplateId,
  input: Pick<ProjectInitInput, "createdBy" | "createdByAgentId" | "createdBySessionName">,
) {
  const template = getTemplateDefinition(templateId);
  const existing = getWorkflowSpec(template.specId);
  if (existing) {
    return existing;
  }

  return createWorkflowSpec({
    id: template.specId,
    title: template.spec.title,
    summary: template.spec.summary,
    policy: template.spec.policy,
    nodes: template.spec.nodes,
    edges: template.spec.edges,
    createdBy: input.createdBy,
    createdByAgentId: input.createdByAgentId,
    createdBySessionName: input.createdBySessionName,
  });
}

function getWorkflowLinkRole(index: number): ProjectWorkflowLinkRole {
  return index === 0 ? "primary" : "support";
}

function getLinkedProjectLink(
  details: NonNullable<ReturnType<typeof getProjectDetails>>,
  assetType: ProjectLink["assetType"],
  assetId: string,
) {
  return details.links.find((link) => link.assetType === assetType && link.assetId === assetId) ?? null;
}

export function initProject(input: ProjectInitInput): ProjectInitResult {
  const workflowRunIds = normalizeList(input.workflowRunIds);
  const workflowTemplates = normalizeList(input.workflowTemplates).map((entry) =>
    requireProjectWorkflowTemplateId(entry),
  );

  if (workflowRunIds.length + workflowTemplates.length > MAX_PROJECT_INIT_WORKFLOWS) {
    throw new Error(`Project init supports at most ${MAX_PROJECT_INIT_WORKFLOWS} workflows per bootstrap.`);
  }

  const explicitWorkflowDetails = workflowRunIds.map((runId) => {
    const details = getWorkflowRunDetails(runId);
    if (!details) {
      throw new Error(`Workflow run not found: ${runId}`);
    }
    return details;
  });

  const project = createProject({
    title: input.title,
    ...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    ...(input.hypothesis?.trim() ? { hypothesis: input.hypothesis.trim() } : {}),
    ...(input.nextStep?.trim() ? { nextStep: input.nextStep.trim() } : {}),
    ...(typeof input.lastSignalAt === "number" ? { lastSignalAt: input.lastSignalAt } : {}),
    ...(input.ownerAgentId !== undefined ? { ownerAgentId: input.ownerAgentId } : {}),
    ...(input.operatorSessionName !== undefined ? { operatorSessionName: input.operatorSessionName } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.createdByAgentId ? { createdByAgentId: input.createdByAgentId } : {}),
    ...(input.createdBySessionName ? { createdBySessionName: input.createdBySessionName } : {}),
  });

  let details = getProjectDetails(project.id)!;
  let ownerLink: ProjectLink | null = null;
  let sessionLink: ProjectLink | null = null;
  const resourceLinks: ProjectLink[] = [];
  const workflows: ProjectInitializedWorkflow[] = [];

  if (input.ownerAgentId?.trim()) {
    details = linkProject({
      projectRef: project.id,
      assetType: "agent",
      assetId: input.ownerAgentId,
      role: "owner",
      createdBy: input.createdBy,
      createdByAgentId: input.createdByAgentId,
      createdBySessionName: input.createdBySessionName,
    });
    ownerLink = getLinkedProjectLink(details, "agent", input.ownerAgentId);
  }

  if (input.operatorSessionName?.trim()) {
    details = linkProject({
      projectRef: project.id,
      assetType: "session",
      assetId: input.operatorSessionName,
      role: "operator",
      createdBy: input.createdBy,
      createdByAgentId: input.createdByAgentId,
      createdBySessionName: input.createdBySessionName,
    });
    sessionLink = getLinkedProjectLink(details, "session", input.operatorSessionName);
  }

  for (const resource of input.resources ?? []) {
    const assetId = resource.assetId.trim();
    if (!assetId) continue;

    details = linkProject({
      projectRef: project.id,
      assetType: "resource",
      assetId,
      role: normalizeRole(resource.role) ?? defaultResourceRole(resource.type),
      metadata: buildResourceMetadata({
        ...resource,
        assetId,
      }),
      createdBy: input.createdBy,
      createdByAgentId: input.createdByAgentId,
      createdBySessionName: input.createdBySessionName,
    });

    const linked = getLinkedProjectLink(details, "resource", assetId);
    if (linked) {
      resourceLinks.push(linked);
    }
  }

  const linkedWorkflowCountStart = 0;
  let linkedWorkflowIndex = linkedWorkflowCountStart;

  for (const workflow of explicitWorkflowDetails) {
    const role = getWorkflowLinkRole(linkedWorkflowIndex);
    details = linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: workflow.run.id,
      role,
      createdBy: input.createdBy,
      createdByAgentId: input.createdByAgentId,
      createdBySessionName: input.createdBySessionName,
    });
    workflows.push({
      source: "existing",
      workflowRunId: workflow.run.id,
      workflowSpecId: workflow.spec.id,
      workflowTitle: workflow.run.title,
      workflowStatus: workflow.run.status,
      role,
    });
    linkedWorkflowIndex += 1;
  }

  for (const templateId of workflowTemplates) {
    const spec = ensureCanonicalWorkflowSpec(templateId, input);
    const workflow = startWorkflowRun(spec.id, {
      createdBy: input.createdBy,
      createdByAgentId: input.createdByAgentId,
      createdBySessionName: input.createdBySessionName,
    });
    const role = getWorkflowLinkRole(linkedWorkflowIndex);
    details = linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: workflow.run.id,
      role,
      createdBy: input.createdBy,
      createdByAgentId: input.createdByAgentId,
      createdBySessionName: input.createdBySessionName,
    });
    workflows.push({
      source: "template",
      templateId,
      workflowRunId: workflow.run.id,
      workflowSpecId: workflow.spec.id,
      workflowTitle: workflow.run.title,
      workflowStatus: workflow.run.status,
      role,
    });
    linkedWorkflowIndex += 1;
  }

  return {
    details,
    ownerLink,
    sessionLink,
    resourceLinks,
    workflows,
  };
}
