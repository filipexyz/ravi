import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { KnowledgeRouteCardScreen } from "@/features/knowledge-cards/knowledge-card-screens";
import { getConsoleAuthState } from "@/lib/auth/session";
import { loadKnowledgeRouteCard } from "@/server/console/knowledge/proposals";
import { raviLinkApproverFromAuth } from "@/server/console/ravi-link-web";
import { ConsoleEmailVerificationRequiredError, getConsoleWorkspace } from "@/server/console/workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Knowledge page mark",
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type KnowledgeRoutePageProps = {
  params: Promise<{ routeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// Who hears one page route, in the route's own organization. Anyone without
// project read gets the same view as a missing id. Opening it changes nothing.
export default async function KnowledgeRoutePage({ params, searchParams }: KnowledgeRoutePageProps) {
  const { routeId } = await params;
  const query = await searchParams;
  const auth = await getConsoleAuthState();
  try {
    await raviLinkApproverFromAuth(auth);
  } catch (caught) {
    if (caught instanceof ConsoleEmailVerificationRequiredError) redirect("/");
    throw caught;
  }
  const card = await loadKnowledgeRouteCard({
    routeId,
    workspaceFor: (organizationId) => getConsoleWorkspace(auth, { organizationRef: organizationId }).catch(() => null),
  });
  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <KnowledgeRouteCardScreen
        card={card}
        flash={{ done: firstParam(query?.done) ?? null, error: firstParam(query?.error) ?? null }}
        viewer={{ email: auth.viewer.email, name: auth.viewer.name }}
      />
    </ConsoleAuthBoundary>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
