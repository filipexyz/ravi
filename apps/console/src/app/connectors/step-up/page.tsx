import { notFound, redirect } from "next/navigation";

import { Card, SlashMark } from "@/components/ui";
import { getConsoleAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { getSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";

import { StepUpPanel } from "./step-up-panel";

export const dynamic = "force-dynamic";

interface StepUpPageProps {
  searchParams: Promise<{ challenge?: string; capability?: string }>;
}

export default async function StepUpPage({ searchParams }: StepUpPageProps) {
  const params = await searchParams;
  const challengeId = params.challenge?.trim();
  const capability = params.capability?.trim();
  if (!challengeId) {
    return (
      <main className="fullbleed">
        <Card className="col">
          <div style={{ maxWidth: 420, padding: 28 }}>
            <div className="col gap-12">
              <SlashMark label="step-up" num={1} />
              <h1 className="t-h1">Missing challenge.</h1>
              <p className="t-body t-mute" style={{ margin: 0 }}>
                This URL is missing the challenge identifier. Return to the CLI and try again.
              </p>
            </div>
          </div>
        </Card>
      </main>
    );
  }

  const authState = await getConsoleAuthState();
  if (!authState) {
    redirect(`/login?next=${encodeURIComponent(`/connectors/step-up?challenge=${challengeId}`)}`);
  }

  let workspace: Awaited<ReturnType<typeof getSelectedConsoleWorkspace>>;
  try {
    workspace = await getSelectedConsoleWorkspace(authState);
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      redirect("/org");
    }
    throw error;
  }
  try {
    await assertConsoleFeatureAccess(workspace, "console.connectors");
  } catch (error) {
    if (error instanceof ConsoleApiError) notFound();
    throw error;
  }

  return (
    <main className="fullbleed">
      <Card className="col">
        <div style={{ maxWidth: 460, padding: 28 }}>
          <div className="row gap-12" style={{ marginBottom: 24 }}>
            <span className="side-brand-mark">R</span>
            <div>
              <div className="t-h2">Ravi Link · step-up</div>
              <div className="t-mono t-small t-mute">{workspace.organization.slug}</div>
            </div>
          </div>
          <div className="col gap-12">
            <SlashMark label="confirm" num={1} />
            <h1 className="t-h1">Confirm to continue.</h1>
            <p className="t-body t-mute" style={{ margin: 0 }}>
              The CLI requested a destructive action (
              <span className="t-mono">{capability ?? "unknown capability"}</span>) on connector{" "}
              <span className="t-mono">{challengeId.slice(0, 8)}…</span>.
            </p>
            <StepUpPanel
              capability={capability ?? ""}
              challengeId={challengeId}
              userEmail={workspace.user.primaryEmail}
            />
            <p className="t-tiny t-mute" style={{ marginTop: 4 }}>
              Signed in as {workspace.user.primaryEmail}. The code below is single-use and expires in 5 minutes.
            </p>
          </div>
        </div>
      </Card>
    </main>
  );
}
