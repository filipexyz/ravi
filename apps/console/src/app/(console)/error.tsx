"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { ConsoleErrorView } from "@/features/account/fallback-views";

export default function ConsoleError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  useEffect(() => {
    // Server errors carry a digest and were already reported by the server.
    if (!error.digest) Sentry.captureException(error);
  }, [error]);

  return <ConsoleErrorView digest={error.digest} onRetry={() => (unstable_retry ?? reset)?.()} />;
}
