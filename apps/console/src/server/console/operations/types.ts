// The Console operation registry: what an agent may do in the Console, as one
// person, through which surface. It is the first slice of the action registry
// (`.ravi/specs/console/action-registry`) and feeds the Page chat agent and
// the Console mode of mcp.ravi.so. See `.ravi/specs/console/operations/SPEC.md`.

import type { JsonSchemaObject } from "@/server/console/pages/connectors/catalog";

export type OperationClass = "read" | "write" | "destructive";

/** Where the call comes from: the agent inside a Page chat, or an MCP client signed in as the person. */
export type OperationSurface = "page_chat" | "mcp";

/** The site a Page chat conversation happens on. */
export type OperationSite = {
  id: string;
  organizationId: string;
  projectId: string;
  defaultHostname: string;
  defaultVisibility: "public" | "private" | "protected_link" | "password";
  activeReleaseId: string | null;
};

/**
 * The person an operation runs as. Every operation runs with this person's own
 * rights (project access, Bases view grants, marked pages); the agent never
 * has rights of its own.
 */
export type OperationActor = {
  /** Server-verified CLI delegation, when this operation came from an installation. */
  authorization?: import("../authorization/identity").AuthorizationActor["delegation"];
  kind: "member" | "guest";
  organizationId: string;
  userId: string;
  email: string | null;
  /** Org role for a member; null for a guest. */
  orgRole: string | null;
  surface: OperationSurface;
  requestId: string;
  /** Page chat only: the site of the conversation. */
  site: OperationSite | null;
  /** Page chat only: the `pages_sessions.id` (never the token) the person wrote with. */
  pagesSessionId: string | null;
  /**
   * A cloud agent run token: the only project this call may read or change.
   * Every operation refuses anything that resolves to another project.
   */
  boundProjectId?: string | null;
};

export type OperationDefinition = {
  id: string;
  title: string;
  description: string;
  class: OperationClass;
  /** Writes always wait for the person's click (Page chat) or an explicit confirm call (MCP). */
  needsConfirmation: boolean;
  surfaces: readonly OperationSurface[];
  /** Guests (people outside the org given a page) may call it. */
  guests: boolean;
  /** JSON Schema of the input as the agent sees it on `surface`. */
  inputSchema: (surface: OperationSurface) => JsonSchemaObject;
  /** Checks a write's input before a confirmation is offered; throws a ZodError or ConsoleApiError. */
  validateInput?: (input: Record<string, unknown>) => void;
};

export type OperationRunResult = {
  id: string;
  class: OperationClass;
  output: unknown;
};

/** One line of what a write will change, shown on the confirmation card. */
export type OperationChangeLine = { label: string; value: string };

/** One call of an operation handler, after the registry's checks. */
export type OperationCall = {
  actor: OperationActor;
  input: Record<string, unknown>;
  /** The confirmation seed of a write (a confirmation token id, an approval id). */
  idempotencySeed?: string;
};

/**
 * An operation that runs its own service instead of the Pages connectors
 * catalog. Areas group them in their own module (`bases-admin.ts`,
 * `cloud-agents.ts`, ...) and the registry lists and dispatches them.
 */
export type OperationHandler = {
  definition: OperationDefinition;
  /**
   * A cloud run token (a project-bound actor) may call it: `run` resolves
   * every project through `resolveOperationProject` or `keepInBoundProject`,
   * so nothing outside the run's project is read or changed.
   */
  projectBound: boolean;
  run: (call: OperationCall) => Promise<unknown>;
  /** The confirmation card's lines for a write, from the validated input. */
  describeChange?: (input: Record<string, unknown>) => OperationChangeLine[];
};
