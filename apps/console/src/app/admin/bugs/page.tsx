import { redirect } from "next/navigation";

export default function AdminBugsRedirectPage() {
  redirect("/manage/bugs");
}
