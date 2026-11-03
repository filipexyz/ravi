import type { Metadata } from "next";

import { GlobalNotFound } from "@/features/account/fallback-views";
import { StandaloneFrame } from "@/features/account/standalone-frame";

export const metadata: Metadata = {
  title: "Page not found · Ravi Console",
};

export default function NotFound() {
  return (
    <StandaloneFrame width="sm">
      <GlobalNotFound />
    </StandaloneFrame>
  );
}
