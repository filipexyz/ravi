import type { ContextCapability } from "../router/router-db.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

const TRUSTED_BOOTSTRAP_SUBJECT_TYPES = new Set(["agent", "automation"]);

/**
 * Grupos de comando que todo agente recebe ao nascer pra OPERAR (least-privilege).
 * Dois tipos, ambos essenciais:
 *  - Kit de skill (sessions/tasks/specs/skills): espelham `BASELINE_SYSTEM_SKILL_SLUGS`
 *    (runtime/allowed-skills.ts) e também aparecem como skill no contexto.
 *  - Fabric de operação (self/doctor): introspecção e saúde. NÃO têm skill associada no
 *    mapa de gates, então habilitam rodar o comando SEM poluir o índice de skills.
 * Domínio/admin (cron, crm, whatsapp, db, service…) continuam opt-in por `execute:group:<grupo>`.
 */
const BASELINE_COMMAND_GROUPS = ["sessions", "tasks", "specs", "skills", "self", "doctor"] as const;
const SAFE_EXECUTABLES = [
  "bun",
  "cat",
  "date",
  "find",
  "git",
  "head",
  "ls",
  "nl",
  "pwd",
  "ravi",
  "rg",
  "sed",
  "sort",
  "tail",
  "uniq",
  "wc",
  "xargs",
];

/**
 * Temporary explicit bootstrap materializer for the provider-runtime era.
 *
 * This provider is intentionally not relation-backed. It is a narrow executor
 * bridge while app/domain providers are introduced: actor and surface subjects
 * must get authority from real providers, not from bootstrap defaults.
 */
export const runtimeBootstrapProvider: PermissionProvider = {
  id: "runtime-bootstrap",
  version: "bootstrap/v1",
  required: true,
  supports() {
    return false;
  },
  authorize(request) {
    return notApplicableDecision(request);
  },
  materializeCapabilities(subject) {
    if (!isTrustedBootstrapSubject(subject.type, subject.id)) return [];
    return bootstrapCapabilitiesFor(subject.type);
  },
};

function isTrustedBootstrapSubject(subjectType: string, subjectId: string): boolean {
  const normalizedId = subjectId.trim().toLowerCase();
  return TRUSTED_BOOTSTRAP_SUBJECT_TYPES.has(subjectType) && normalizedId.length > 0 && normalizedId !== "unknown";
}

function bootstrapCapabilitiesFor(subjectType: string): ContextCapability[] {
  const source = `runtime-bootstrap:${subjectType}`;
  return [
    { permission: "use", objectType: "tool", objectId: "*", source },
    { permission: "use", objectType: "toolgroup", objectId: "*", source },
    // Least-privilege default (spec: skills/scoping/per-agent-visibility, decisão RM 2026-07-03):
    // agente nasce só com BASELINE_COMMAND_GROUPS (kit de skill + fabric de operação) —
    // o suficiente pra operar (falar, trabalhar, ler regras, criar skill, introspectar, checar saúde).
    // Domínio/admin é opt-in por `execute:group:<grupo>`. Substitui o antigo `execute:group:*`,
    // que dava tudo a todo agente e deixava o filtro de skills inerte.
    ...BASELINE_COMMAND_GROUPS.map((objectId) => ({
      permission: "execute" as const,
      objectType: "group" as const,
      objectId,
      source,
    })),
    ...SAFE_EXECUTABLES.map((objectId) => ({
      permission: "execute",
      objectType: "executable",
      objectId,
      source,
    })),
    {
      permission: "read_own_contacts",
      objectType: "system",
      objectId: "*",
      source,
    },
  ];
}

function notApplicableDecision(request: PermissionProviderRequest): PermissionProviderDecision {
  return {
    decision: "not_applicable",
    allowed: false,
    providerId: runtimeBootstrapProvider.id,
    providerVersion: runtimeBootstrapProvider.version,
    reasonCode: "runtime_bootstrap_materializer_only",
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    ...(request.subject ? { subject: request.subject } : {}),
  };
}
