import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { ManageFrame } from "@/components/manage-shell";
import { requirePlatformOperatorPage } from "@/server/console/manage-page";

export default async function ManageLayout({ children }: { children: React.ReactNode }) {
  const { auth } = await requirePlatformOperatorPage();

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <ManageFrame viewer={auth.viewer}>{children}</ManageFrame>
    </ConsoleAuthBoundary>
  );
}
