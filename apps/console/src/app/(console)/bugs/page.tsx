import type { Metadata } from "next";

import { BugsScreen } from "@/features/account/bugs-screen";

export const metadata: Metadata = {
  title: "My bug reports · Ravi Console",
};

export default function BugsPage() {
  return <BugsScreen />;
}
