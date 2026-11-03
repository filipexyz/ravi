/**
 * WorkOS step-up provider.
 *
 * Issues a verification URL pointing to the Console-hosted step-up page,
 * which renders a factor challenge (passkey, TOTP, SMS, or password
 * reauth). Verifies that Console actually completed the factor by
 * unwrapping the HMAC-signed assertion Console attaches to the mint
 * call.
 *
 * Refs:
 *   - https://workos.com/docs/user-management/factors
 */

import {
  isFactorAllowedForCapability,
  type StepUpChallenge,
  type StepUpChallengeRequest,
  type StepUpFactor,
  type StepUpProvider,
  type StepUpVerifyRequest,
  type StepUpVerifyResult,
} from "./provider";

export interface WorkOSStepUpProviderConfig {
  consoleBaseUrl: string;
  workosApiKey: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
}

export interface WorkOSVerificationPayload {
  factor: StepUpFactor;
  consoleAssertionToken: string;
}

export function createWorkOSStepUpProvider(config: WorkOSStepUpProviderConfig): StepUpProvider {
  return {
    providerId: "workos",

    async challenge(request: StepUpChallengeRequest): Promise<StepUpChallenge> {
      const url = new URL(`${config.consoleBaseUrl.replace(/\/$/, "")}/connectors/step-up`);
      url.searchParams.set("challenge", request.connectorId);
      url.searchParams.set("capability", request.capability);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      return {
        challengeId: request.connectorId,
        verificationUrl: url.toString(),
        expiresAt,
      };
    },

    async verify(request: StepUpVerifyRequest): Promise<StepUpVerifyResult> {
      const payload = request.providerResponse as Partial<WorkOSVerificationPayload> | undefined;
      const factor = payload?.factor;
      if (!factor || !isFactor(factor)) {
        return { verified: false, factor: null, rejectionReason: "missing_factor" };
      }
      if (!payload?.consoleAssertionToken) {
        return { verified: false, factor, rejectionReason: "missing_console_assertion" };
      }

      const assertion = await verifyAssertion(payload.consoleAssertionToken, config.hmacSecret);
      if (!assertion) {
        return { verified: false, factor, rejectionReason: "console_assertion_invalid" };
      }
      if (assertion.challengeId !== request.challengeId) {
        return { verified: false, factor, rejectionReason: "console_assertion_challenge_mismatch" };
      }
      if (assertion.factor !== factor) {
        return { verified: false, factor, rejectionReason: "console_assertion_factor_mismatch" };
      }
      const ageSeconds = Math.floor(Date.now() / 1000) - assertion.issuedAt;
      if (ageSeconds > 300 || ageSeconds < -60) {
        return { verified: false, factor, rejectionReason: "console_assertion_expired" };
      }

      void config.fetchImpl;
      void config.workosApiKey;
      return { verified: true, factor, rejectionReason: null };
    },
  };
}

interface DecodedAssertion {
  challengeId: string;
  userId: string;
  organizationId: string;
  factor: string;
  issuedAt: number;
}

async function verifyAssertion(token: string, secret: string): Promise<DecodedAssertion | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) return null;

  let decoded: string;
  try {
    decoded = base64UrlDecode(payloadB64);
  } catch {
    return null;
  }
  const expected = await hmacSha256Base64Url(secret, decoded);
  if (!timingSafeEqualString(expected, signatureB64)) return null;

  const fields = decoded.split(":");
  if (fields.length < 5) return null;
  const [challengeId, userId, organizationId, factor, issuedAtStr] = fields;
  if (!challengeId || !userId || !organizationId || !factor || !issuedAtStr) return null;
  const issuedAt = Number.parseInt(issuedAtStr, 10);
  if (!Number.isFinite(issuedAt)) return null;
  return { challengeId, userId, organizationId, factor, issuedAt };
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message) as BufferSource);
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isFactor(value: string): value is StepUpFactor {
  return value === "passkey" || value === "totp" || value === "sms" || value === "password";
}

export { isFactorAllowedForCapability };
