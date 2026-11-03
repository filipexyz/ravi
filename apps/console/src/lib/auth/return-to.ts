export type AuthSearchParams = Record<string, string | string[] | undefined>;

export function authReturnToFromRecord(searchParams: AuthSearchParams | null | undefined) {
  return (
    safeAuthReturnTo(firstValue(searchParams?.returnTo)) ??
    safeAuthReturnTo(firstValue(searchParams?.next)) ??
    "/projects"
  );
}

export function authReturnToFromUrl(searchParams: URLSearchParams) {
  return safeAuthReturnTo(searchParams.get("returnTo")) ?? safeAuthReturnTo(searchParams.get("next")) ?? "/projects";
}

export function signInPathForReturnTo(returnTo: string) {
  if (returnTo === "/projects") return "/sign-in";
  const params = new URLSearchParams({ returnTo });
  return `/sign-in?${params.toString()}`;
}

export function safeAuthReturnTo(value: string | null | undefined) {
  const input = value?.trim();
  if (!input) return null;
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  // Browsers read "\" as "/", so "/\evil.example" would leave the Console.
  if (input.includes("\\") || /[\u0000-\u001F\u007F]/.test(input)) return null;
  return input;
}

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}
