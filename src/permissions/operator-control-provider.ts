import type { PermissionProvider } from "./provider-types.js";

export const OPERATOR_CONTROL_PROVIDER_ID = "operator-control";

/**
 * Local operator control-plane authorization.
 *
 * This is deliberately explicit: a missing subject/context never implies
 * operator authority unless the caller opts into localOperator mode.
 */
export const operatorControlProvider: PermissionProvider = {
  id: OPERATOR_CONTROL_PROVIDER_ID,
  version: "operator-control/local-v1",
  required: true,
  supports(request) {
    return request.localOperator === true && !request.context && !request.subject && !request.capabilities;
  },
  authorize(request) {
    return {
      decision: "allow",
      allowed: true,
      providerId: this.id,
      providerVersion: this.version,
      reasonCode: "operator_control_local_allow",
      permission: request.permission,
      objectType: request.objectType,
      objectId: request.objectId,
      evidence: [{ kind: "operator-control", mode: "local" }],
    };
  },
};
