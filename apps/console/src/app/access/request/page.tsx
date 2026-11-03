import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { AccessRequestFormScreen, type AccessRequestFormState } from "@/features/account/access-request-screens";
import { getConsoleAuthState } from "@/lib/auth/session";
import { accessRequestErrorMessage } from "@/server/console/access/request-copy";
import { resolvePageTarget } from "@/server/console/access/targets";
import { ConsoleApiError } from "@/server/console/api-error";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ask for access",
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type AccessRequestPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// Linked from the Pages "Access denied" screen. Showing the form changes nothing.
export default async function AccessRequestPage({ searchParams }: AccessRequestPageProps) {
  const query = await searchParams;
  const returnTo = firstParam(query?.returnTo) ?? "";
  const error = firstParam(query?.error);
  const auth = await getConsoleAuthState();

  let state: AccessRequestFormState;
  try {
    const target = await resolvePageTarget(returnTo);
    state = {
      error: error ? accessRequestErrorMessage(error) : null,
      host: target.host,
      kind: "form",
      path: target.path,
      returnTo,
    };
  } catch (caught) {
    if (!(caught instanceof ConsoleApiError)) throw caught;
    state = {
      copy: {
        description: "Open the page again and use its link to ask for access.",
        title: "We couldn't find that page",
      },
      kind: "error",
    };
  }

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <AccessRequestFormScreen state={state} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
