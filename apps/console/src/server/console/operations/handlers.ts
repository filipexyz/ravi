// Operation handlers outside the Pages connectors catalog, one module per
// area. The registry lists them after the catalog operations and dispatches
// them by id. See `.ravi/specs/console/operations/SPEC.md`.

import { BASES_ADMIN_OPERATIONS } from "./bases-admin";
import { CLOUD_AGENTS_OPERATIONS } from "./cloud-agents";
import { KNOWLEDGE_MEETINGS_OPERATIONS } from "./knowledge-meetings";
import { LIBRARY_BUGS_OPERATIONS } from "./library-bugs";
import type { OperationHandler } from "./types";

export const OPERATION_HANDLERS: readonly OperationHandler[] = [
  ...BASES_ADMIN_OPERATIONS,
  ...LIBRARY_BUGS_OPERATIONS,
  ...KNOWLEDGE_MEETINGS_OPERATIONS,
  ...CLOUD_AGENTS_OPERATIONS,
];
