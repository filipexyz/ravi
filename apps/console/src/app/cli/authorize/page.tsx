import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { CliAuthorizeScreen, type CliAuthorizeView } from "@/features/account/cli-authorize-screen";
import { getConsoleAuthState } from "@/lib/auth/session";
import {
  getCliDeviceAuthorizationView,
  normalizeUserCode,
} from "@/server/cli/device-auth";
import { organizationMembershipToOrg } from "@/server/console/read-model";
import { listSelectableConsoleOrganizationMemberships } from "@/server/console/workspace";

export const metadata: Metadata = {
  title: "Approve Ravi CLI sign-in",
  robots: { index: false, follow: false },
};

type CliAuthorizePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// `ravi login` opens /cli/authorize?user_code=XXXX-XXXX (`code` also works).
// Each approval posts userCode + organizationId to /api/console/cli/auth/approve,
// which redirects back here with &approved=1, &select=required or &error=<code>.
export default async function CliAuthorizePage({ searchParams }: CliAuthorizePageProps) {
  const params = await searchParams;
  const userCode = firstParam(params?.user_code ?? params?.code);
  const errorCode = firstParam(params?.error);
  const selectRequired = firstParam(params?.select) === "required";
  const normalizedUserCode = normalizeUserCode(userCode);
  const auth = await getConsoleAuthState();
  const [deviceAuth, memberships] = await Promise.all([
    getCliDeviceAuthorizationView(userCode ?? null),
    listSelectableConsoleOrganizationMemberships(auth),
  ]);
  const orgs = memberships.map(organizationMembershipToOrg);

  let view: CliAuthorizeView;
  if (!normalizedUserCode || deviceAuth.status === "invalid") {
    view = { kind: "invalid" };
  } else if (deviceAuth.status === "expired") {
    view = { kind: "expired" };
  } else if (deviceAuth.status === "approved") {
    view = { kind: "approved" };
  } else if (deviceAuth.status === "consumed") {
    view = { kind: "consumed" };
  } else if (deviceAuth.status === "denied") {
    view = { kind: "denied" };
  } else if (errorCode === "ORG_ACCESS_DENIED") {
    view = { kind: "org_access_denied" };
  } else if (errorCode) {
    view = { kind: "error", code: errorCode };
  } else if (orgs.length === 0) {
    view = { kind: "no_organizations" };
  } else {
    view = {
      kind: "pending",
      expiresAt: deviceAuth.expiresAt,
      organizations: orgs.map((org) => ({ id: org.id, name: org.name, role: org.role })),
      selectRequired,
      userCode: formatUserCode(normalizedUserCode),
    };
  }

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <CliAuthorizeScreen view={view} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatUserCode(value: string) {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}
