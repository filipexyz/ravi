import { notFound } from "next/navigation";

/** Unknown project paths get the Console's not-found inside the shell. */
export default function UnknownProjectPath() {
  notFound();
}
