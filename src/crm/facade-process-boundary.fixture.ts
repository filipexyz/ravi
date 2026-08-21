import { claimCrmFacadePlanApply, createCrmTask } from "../contacts.js";
import {
  approveCrmFacadePlan,
  buildCrmFacadePlan,
  persistCrmFacadePlan,
  recordCrmFacadeApprovalRequest,
} from "./facade.js";

if (!process.env.RAVI_STATE_DIR) throw new Error("RAVI_STATE_DIR is required");

const task = createCrmTask({
  title: "Process boundary fixture",
  sessionKey: "process-boundary-fixture",
  source: "test",
});
const plan = buildCrmFacadePlan({ operation: "task.done", target: task.id });
persistCrmFacadePlan(plan);
recordCrmFacadeApprovalRequest(plan.planId, {
  source: { channel: "test", accountId: "test", chatId: "test" },
  externalMessageId: "process-boundary-message",
  authorizedApproverId: "human-1",
});
approveCrmFacadePlan(plan.planId, {
  externalMessageId: "process-boundary-message",
  approverId: "human-1",
});

if (!claimCrmFacadePlanApply(plan.planId, new Date().toISOString())) {
  throw new Error("Could not claim fixture plan");
}

process.exit(73);
