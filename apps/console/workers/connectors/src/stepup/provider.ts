/**
 * Step-up authentication provider.
 *
 * Destructive capabilities (e.g. `gmail.message.send`,
 * `gcal.event.delete`) require a fresh authorization step that goes
 * through the identity provider's MFA/passkey factor. The connectors
 * Worker depends only on this narrow interface so the identity
 * provider can be swapped without touching the vault, proxy, or CLI.
 *
 * The v1 implementation is `WorkOSStepUpProvider`.
 */

export type StepUpFactor = "passkey" | "totp" | "sms" | "password";

export interface StepUpChallengeRequest {
  userId: string;
  organizationId: string;
  connectorId: string;
  capability: string;
  capabilityClass: "read" | "write" | "destructive";
}

export interface StepUpChallenge {
  challengeId: string;
  verificationUrl: string;
  expiresAt: Date;
}

export interface StepUpVerifyRequest {
  challengeId: string;
  providerResponse: unknown;
}

export interface StepUpVerifyResult {
  verified: boolean;
  factor: StepUpFactor | null;
  rejectionReason: string | null;
}

export interface StepUpProvider {
  readonly providerId: string;
  challenge(request: StepUpChallengeRequest): Promise<StepUpChallenge>;
  verify(request: StepUpVerifyRequest): Promise<StepUpVerifyResult>;
}

/**
 * Capability-class -> allowed factor matrix. The Worker MUST refuse a
 * step-up token whose factor is weaker than the capability requires.
 * The matrix follows the policy in `console/connectors/SPEC.md`:
 *
 *   passkey  -> all destructive capabilities
 *   totp     -> all destructive capabilities
 *   sms      -> all destructive except `*.delete`
 *   password -> only `*.send` / `*.update`
 */
export function isFactorAllowedForCapability(
  factor: StepUpFactor,
  capability: string,
  capabilityClass: "read" | "write" | "destructive",
): boolean {
  if (capabilityClass !== "destructive") return true;
  if (factor === "passkey" || factor === "totp") return true;
  if (factor === "sms") return !capability.endsWith(".delete");
  if (factor === "password") {
    return capability.endsWith(".send") || capability.endsWith(".update");
  }
  return false;
}
