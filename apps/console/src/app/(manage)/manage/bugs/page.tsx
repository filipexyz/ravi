import { Suspense } from "react";

import { BugOpsInboxScreen } from "@/features/console/bug-ops-screen";

export const dynamic = "force-dynamic";

export default function ManageBugsPage() {
  return (
    <Suspense fallback={null}>
      <BugOpsInboxScreen />
    </Suspense>
  );
}
