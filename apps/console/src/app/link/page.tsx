import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { LinkedAccountsScreen } from "@/features/account/link-screens";
import { getConsoleAuthState } from "@/lib/auth/session";
import { listRaviLinkBindingsForUser } from "@/server/console/ravi-link-requests";
import { getConsoleUserFromAuth } from "@/server/console/workspace";

import { firstParam, linkErrorCopy } from "./_components";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Linked chat accounts",
  robots: { index: false, follow: false },
};

type LinkedAccountsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LinkedAccountsPage({ searchParams }: LinkedAccountsPageProps) {
  const query = await searchParams;
  const auth = await getConsoleAuthState();
  const user = await getConsoleUserFromAuth(auth);
  const bindings = await listRaviLinkBindingsForUser({ consoleUserId: user.id });
  const errorCopy = linkErrorCopy(firstParam(query?.error));
  const revoked = firstParam(query?.revoked) === "1";

  // Each Unlink posts a plain form to /api/console/link/bindings/:id/revoke,
  // which redirects back here with ?revoked=1 or ?error=<code>.
  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <LinkedAccountsScreen
        bindings={bindings.map((binding) => ({
          channel: binding.channel,
          id: binding.id,
          installationName: binding.installationName,
          linkedAt: binding.linkedAt,
          organizationName: binding.organizationName,
        }))}
        error={errorCopy}
        revoked={revoked}
        viewer={{ email: auth.viewer.email, name: auth.viewer.name }}
      />
    </ConsoleAuthBoundary>
  );
}
