import type { Metadata } from "next";

import { ConsoleNotFound } from "@/features/account/fallback-views";

export const metadata: Metadata = {
  title: "Not found · Ravi Console",
};

export default function ConsoleNotFoundPage() {
  return <ConsoleNotFound />;
}
