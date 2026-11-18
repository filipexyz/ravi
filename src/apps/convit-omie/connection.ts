import { AppError } from "./domain.js";

/** Only parse inside the official broker callback in the trusted host. */
export function parseProtectedOmieConnection(serialized: string): {
  auth: { bearer?: string; app_key?: string; app_secret?: string };
  applicationHash: string | null;
} {
  try {
    const value = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const bearer = typeof value.bearer === "string" && value.bearer ? value.bearer : undefined;
    const key = typeof value.app_key === "string" && value.app_key ? value.app_key : undefined;
    const secret = typeof value.app_secret === "string" && value.app_secret ? value.app_secret : undefined;
    if (!bearer && !(key && secret)) throw new Error();
    const applicationHash =
      typeof value.app_hash === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.app_hash) ? value.app_hash : null;
    return { auth: bearer ? { bearer } : { app_key: key, app_secret: secret }, applicationHash };
  } catch {
    throw new AppError("OMIE_CONNECTION_FORMAT_INVALID", "Formato da conexão protegida inválido; valor omitido.");
  }
}
