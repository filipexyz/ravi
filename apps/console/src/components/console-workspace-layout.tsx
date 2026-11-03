import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { RememberOrganization } from "@/components/remember-organization";
import { RenamedOrganizationRedirect } from "@/components/renamed-organization-redirect";
import { ConsoleFrame } from "@/components/shell";
import { OrganizationSelectionScreen } from "@/features/console/org-selection";
import { CenteredScreen } from "@/features/org/organization-picker";
import { Button } from "@/ui/button";
import { CopyValue } from "@/ui/copy";
import { getConsoleAuthState } from "@/lib/auth/session";
import { orgSegment } from "@/lib/console-paths";
import { getConsoleFeatureAccess } from "@/server/console/feature-access";
import { findRenamedOrganization } from "@/server/console/org-urls";
import { isPlatformOperator } from "@/server/console/platform-operator";
import { getCurrentOrganization, listProjects, organizationMembershipToOrg } from "@/server/console/read-model";
import { listPagesSharedWithUser, type SharedPageSummary } from "@/server/console/access/grants";
import { listMeetingsSharedWithUser, type SharedMeetingSummary } from "@/server/console/meetings/sharing";
import {
  CONSOLE_ORGANIZATION_COOKIE,
  ConsoleEmailVerificationRequiredError,
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleUserFromAuth,
  getConsoleWorkspace,
  listSelectableConsoleOrganizationMemberships,
} from "@/server/console/workspace";
import type { ConsoleFeatureAccessData, Org, Project } from "@/features/console/types";

type ConsoleLayoutState =
  | {
      kind: "ready";
      features: ConsoleFeatureAccessData;
      organization: Org;
      platformOperator: boolean;
      projects: Project[];
    }
  | {
      kind: "renamed";
      organizationSegment: string;
    }
  | {
      kind: "selection";
      organizations: Org[];
      platformOperator: boolean;
      sharedMeetings: SharedMeetingSummary[];
      sharedPages: SharedPageSummary[];
    }
  | {
      kind: "email_verification";
    }
  | {
      kind: "failure";
      eventId: string;
    };

/**
 * Resolves the organization a Console screen shows and renders the shell
 * around it. Screens under `/<org>` pass the organization from the URL;
 * screens that belong to no organization (`/bugs`, `/connectors`) use the
 * last one this browser opened. Either way the reader must be an active
 * member: the reference only picks among their own organizations.
 */
export async function ConsoleWorkspaceLayout({
  children,
  urlOrganization = null,
}: {
  children: React.ReactNode;
  /** The organization segment of the URL, for screens under `/<org>`. */
  urlOrganization?: string | null;
}) {
  const auth = await getConsoleAuthState();
  const cookieStore = await cookies();
  const cookieOrganization = cookieStore.get(CONSOLE_ORGANIZATION_COOKIE)?.value ?? null;
  const organizationRef = urlOrganization ?? cookieOrganization;
  let state: ConsoleLayoutState;
  let rememberOrganizationId: string | null = null;

  try {
    const workspace = await getConsoleWorkspace(auth, { organizationRef });
    if (
      urlOrganization &&
      workspace.organization.id !== urlOrganization &&
      workspace.organization.slug !== urlOrganization
    ) {
      // Anonymous mode has one organization and ignores the reference.
      throw new ConsoleWorkspaceSelectionRequiredError(await listSelectableConsoleOrganizationMemberships(auth));
    }

    const [organization, projects, features, platformOperator] = await Promise.all([
      getCurrentOrganization(workspace),
      listProjects(workspace),
      getConsoleFeatureAccess(workspace),
      isPlatformOperator(workspace.user),
    ]);

    if (urlOrganization && cookieOrganization !== workspace.organization.id) {
      rememberOrganizationId = workspace.organization.id;
    }

    state = {
      features,
      kind: "ready",
      organization,
      platformOperator,
      projects,
    };
  } catch (error) {
    const renamed =
      urlOrganization && error instanceof ConsoleWorkspaceSelectionRequiredError
        ? await findRenamedOrganization(error.organizations, urlOrganization)
        : null;
    if (renamed) {
      state = { kind: "renamed", organizationSegment: orgSegment(renamed) };
    } else if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      const user = await getConsoleUserFromAuth(auth);
      const [platformOperator, sharedPages, sharedMeetings] = await Promise.all([
        isPlatformOperator(user),
        listPagesSharedWithUser({ userId: user.id }),
        listMeetingsSharedWithUser({ userId: user.id }),
      ]);
      state = {
        kind: "selection",
        organizations: error.organizations.map(organizationMembershipToOrg),
        platformOperator,
        sharedMeetings,
        sharedPages,
      };
    } else if (error instanceof ConsoleEmailVerificationRequiredError) {
      state = { kind: "email_verification" };
    } else {
      const eventId = captureConsoleLayoutException(error, {
        organizationRef: organizationRef ? "present" : "missing",
        surface: "console-layout",
      });
      await Sentry.flush(2000);

      state = {
        eventId,
        kind: "failure",
      };
    }
  }

  if (state.kind === "renamed") {
    return <RenamedOrganizationRedirect from={urlOrganization ?? ""} to={state.organizationSegment} />;
  }

  if (state.kind === "selection") {
    return (
      <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
        <OrganizationSelectionScreen
          deniedOrganization={urlOrganization ?? undefined}
          manageHref={state.platformOperator ? "/manage" : undefined}
          orgs={state.organizations}
          sharedMeetings={state.sharedMeetings}
          sharedPages={state.sharedPages}
        />
      </ConsoleAuthBoundary>
    );
  }

  if (state.kind === "email_verification") {
    return (
      <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
        <CenteredScreen
          description="Someone added this email to Ravi before you signed in. To take over that access, sign in with a method that verifies the address, such as a code sent to your email or Google."
          title="Verify your email"
        >
          <div className="flex flex-wrap gap-2">
            <Button external href="/logout" variant="primary">
              Sign in again
            </Button>
          </div>
        </CenteredScreen>
      </ConsoleAuthBoundary>
    );
  }

  if (state.kind === "failure") {
    return (
      <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
        <ConsoleBootstrapFailureScreen eventId={state.eventId} />
      </ConsoleAuthBoundary>
    );
  }

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      {rememberOrganizationId ? <RememberOrganization organizationId={rememberOrganizationId} /> : null}
      <ConsoleFrame
        features={state.features}
        organization={state.organization}
        platformOperator={state.platformOperator}
        projects={state.projects}
        viewer={auth.viewer}
      >
        {children}
      </ConsoleFrame>
    </ConsoleAuthBoundary>
  );
}

function captureConsoleLayoutException(
  error: unknown,
  context: { organizationRef: "present" | "missing"; surface: string },
) {
  return Sentry.captureException(error, {
    tags: {
      feature: "console-layout",
      surface: "console",
    },
    contexts: {
      consoleLayout: context,
    },
  });
}

function ConsoleBootstrapFailureScreen({ eventId }: { eventId: string }) {
  return (
    <CenteredScreen
      description="Something went wrong while opening your organization. Try again, or sign out and sign in again."
      title="The Console couldn't load"
    >
      <div className="space-y-4 rounded-lg border border-line bg-surface p-5">
        {eventId ? (
          <div className="space-y-1">
            <div className="text-[13px] text-ink-3">If it keeps happening, send this reference to the Ravi team.</div>
            <CopyValue value={eventId} />
          </div>
        ) : (
          <div className="text-[13px] text-ink-3">If it keeps happening, contact the Ravi team.</div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button external href="/projects" variant="primary">
            Try again
          </Button>
          <Button external href="/logout" variant="ghost">
            Sign out
          </Button>
        </div>
      </div>
    </CenteredScreen>
  );
}
