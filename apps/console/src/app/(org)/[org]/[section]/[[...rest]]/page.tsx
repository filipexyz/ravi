import { notFound } from "next/navigation";

/** Unknown organization paths get the Console's not-found inside the shell. */
export default function UnknownOrganizationPath() {
  notFound();
}
