import { redirect } from "next/navigation";

export default async function AdminBugDetailRedirectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/manage/bugs/${id}`);
}
