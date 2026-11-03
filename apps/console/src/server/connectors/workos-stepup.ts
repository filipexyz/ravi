/**
 * WorkOS-backed step-up verification helpers.
 *
 * v1 implements password reauth: the user re-enters their Console
 * password on the step-up page and the Console server calls the
 * WorkOS User Management `authenticate` endpoint with
 * `grant_type=password` to confirm the credential is still valid.
 *
 * Future expansions (TOTP, passkey/WebAuthn) MUST plug into the same
 * StepUpVerificationResult contract so the mint route stays agnostic.
 */

const WORKOS_AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";

export type StepUpFactor = "passkey" | "totp" | "sms" | "password";

export interface StepUpVerificationResult {
  verified: boolean;
  factor: StepUpFactor | null;
  rejectionReason: StepUpRejectionReason | null;
}

export type StepUpRejectionReason =
  | "missing_credentials"
  | "credentials_invalid"
  | "workos_unavailable"
  | "workos_not_configured";

export interface PasswordReauthInput {
  email: string;
  password: string;
}

export function getWorkOSCredentials(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string;
  clientId: string;
} | null {
  const apiKey = env.WORKOS_API_KEY?.trim();
  const clientId = env.WORKOS_CLIENT_ID?.trim();
  if (!apiKey || !clientId) return null;
  return { apiKey, clientId };
}

/**
 * Verify a password reauth attempt via WorkOS User Management. Returns
 * `verified: true` only on a 200 response that includes a valid user
 * payload whose email matches `input.email`.
 *
 * No plaintext password is logged; any non-2xx response is collapsed to
 * `credentials_invalid` for the caller.
 */
export async function verifyPasswordReauth(
  input: PasswordReauthInput,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<StepUpVerificationResult> {
  const creds = getWorkOSCredentials();
  if (!creds) {
    return { verified: false, factor: null, rejectionReason: "workos_not_configured" };
  }
  if (!input.email || !input.password) {
    return { verified: false, factor: null, rejectionReason: "missing_credentials" };
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(WORKOS_AUTHENTICATE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "password",
        email: input.email,
        password: input.password,
        client_id: creds.clientId,
      }),
    });
  } catch {
    return { verified: false, factor: null, rejectionReason: "workos_unavailable" };
  }

  if (!response.ok) {
    // WorkOS returns 401 for bad password; treat any non-200 as invalid
    // without distinguishing reasons to the caller.
    return { verified: false, factor: "password", rejectionReason: "credentials_invalid" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { verified: false, factor: "password", rejectionReason: "workos_unavailable" };
  }
  if (!body || typeof body !== "object") {
    return { verified: false, factor: "password", rejectionReason: "workos_unavailable" };
  }
  const user = (body as { user?: { email?: unknown } }).user;
  const userEmail = typeof user?.email === "string" ? user.email.toLowerCase() : null;
  if (!userEmail || userEmail !== input.email.trim().toLowerCase()) {
    return { verified: false, factor: "password", rejectionReason: "credentials_invalid" };
  }
  return { verified: true, factor: "password", rejectionReason: null };
}
