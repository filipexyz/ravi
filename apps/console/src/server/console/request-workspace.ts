import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { CONSOLE_ORGANIZATION_HEADER, CONSOLE_ORGANIZATION_PARAM } from "@/lib/console-paths";
import {
  CONSOLE_ORGANIZATION_COOKIE,
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
  type ConsoleWorkspace,
} from "@/server/console/workspace";

type RequestLike = {
  cookies: { get(name: string): { value: string } | undefined };
  headers: Headers;
  nextUrl?: URL;
  url?: string;
};

/**
 * The organization a Console request asks for. A page under `/<org>` sends
 * its organization in the `x-ravi-org` header (or `?org=` where a header
 * can't be set: images, event streams); otherwise the one this browser used
 * last, from the cookie. This only picks among the reader's organizations:
 * `getConsoleWorkspace` still requires an active membership.
 */
export function requestOrganizationRef(request: RequestLike): string | null {
  const header = request.headers.get(CONSOLE_ORGANIZATION_HEADER)?.trim();
  if (header) return header;
  const url = request.nextUrl ?? (request.url ? safeUrl(request.url) : null);
  const param = url?.searchParams.get(CONSOLE_ORGANIZATION_PARAM)?.trim();
  if (param) return param;
  return request.cookies.get(CONSOLE_ORGANIZATION_COOKIE)?.value ?? null;
}

export async function getSelectedConsoleWorkspace(
  auth: ConsoleAuthState,
  options: { organizationRef?: string | null } = {},
): Promise<ConsoleWorkspace> {
  const organizationRef =
    options.organizationRef?.trim() ||
    (await headers()).get(CONSOLE_ORGANIZATION_HEADER)?.trim() ||
    (await cookies()).get(CONSOLE_ORGANIZATION_COOKIE)?.value ||
    null;
  return getConsoleWorkspace(auth, { organizationRef });
}

export async function getOptionalSelectedConsoleWorkspace(
  auth: ConsoleAuthState,
  options: { organizationRef?: string | null } = {},
): Promise<ConsoleWorkspace | null> {
  try {
    return await getSelectedConsoleWorkspace(auth, options);
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) return null;
    throw error;
  }
}

export async function getInternalSelectedConsoleWorkspace(
  auth: ConsoleAuthState,
  requestId: string,
): Promise<ConsoleWorkspace | NextResponse> {
  try {
    return await getSelectedConsoleWorkspace(auth);
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json(
        { status: "error", code: error.code },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    throw error;
  }
}

/** Remembers an organization for screens and old links that name none. */
export function setConsoleOrganizationCookie(response: NextResponse, organizationId: string) {
  response.cookies.set(CONSOLE_ORGANIZATION_COOKIE, organizationId, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
    sameSite: "lax",
    secure: process.env.RAVI_AUTH_MODE === "oidc" || process.env.NODE_ENV === "production",
  });
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
