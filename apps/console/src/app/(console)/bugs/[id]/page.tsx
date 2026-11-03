import type { Metadata } from "next";

import { BugDetailScreen } from "@/features/account/bug-detail-screen";

export const metadata: Metadata = {
  title: "Bug report · Ravi Console",
};

export default async function BugReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BugDetailScreen id={id} />;
}
