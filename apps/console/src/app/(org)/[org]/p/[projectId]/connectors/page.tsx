import { redirect } from "next/navigation";

/** Connections belong to the person, not the project. Older project links land on the person's list. */
export default function ProjectConnectorsPage() {
  redirect("/connectors");
}
