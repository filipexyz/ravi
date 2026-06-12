import { dbListCronJobs } from "../cron/cron-db.js";
import { executeWrite } from "../db/write-retry.js";
import { getDb, getDefaultAgentId } from "../router/router-db.js";
import { dbListTriggers } from "../triggers/triggers-db.js";
import { logger } from "../utils/logger.js";
import { clearRelations, grantRelation, listRelations } from "./relations.js";

const log = logger.child("permissions:automation-reconcile");

const AUTOMATION_CONFIG_SOURCE = "config";

interface AutomationPrincipal {
  principalId: string;
  agentId: string;
}

/**
 * Mirror each automation principal's executor-agent role memberships onto the
 * automation subject.
 *
 * Cron/trigger turns run under an `automation:<id>` principal, not the executor
 * agent. Without this, an automation that drives a role-scoped agent is denied
 * because its principal carries no capabilities. Mirroring the executor agent's
 * role memberships gives the automation exactly the executor's authority,
 * deterministically, for every configured automation.
 *
 * Idempotent: clears prior automation config memberships and re-derives from the
 * current cron/trigger config. Runs after `syncRelationsFromConfig()` on boot.
 * Only `member role:<id>` memberships are mirrored — automations inherit the
 * executor's roles, which is the supported least-privilege unit.
 */
export function reconcileAutomationPrincipals(): number {
  const db = getDb();
  let granted = 0;

  executeWrite(
    db,
    () => {
      clearRelations({ subjectType: "automation", source: AUTOMATION_CONFIG_SOURCE });

      const defaultAgent = getDefaultAgentId();
      const principals = collectAutomationPrincipals(defaultAgent);

      for (const principal of principals) {
        const roles = listRelations({
          subjectType: "agent",
          subjectId: principal.agentId,
          relation: "member",
          objectType: "role",
        });
        for (const role of roles) {
          grantRelation("automation", principal.principalId, "member", "role", role.objectId, AUTOMATION_CONFIG_SOURCE);
          granted++;
        }
      }
    },
    { label: "permissions:reconcileAutomations" },
  );

  if (granted > 0) {
    log.debug("Reconciled automation principal role memberships", { granted });
  }
  return granted;
}

function collectAutomationPrincipals(defaultAgent: string): AutomationPrincipal[] {
  const principals: AutomationPrincipal[] = [];
  for (const job of dbListCronJobs()) {
    principals.push({ principalId: `cron:${job.id}`, agentId: job.agentId ?? defaultAgent });
  }
  for (const trigger of dbListTriggers()) {
    principals.push({ principalId: `trigger:${trigger.id}`, agentId: trigger.agentId ?? defaultAgent });
  }
  return principals;
}
