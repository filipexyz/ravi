import { Plug } from "lucide-react";

import { cn } from "@/lib/cn";

/** The provider's mark in a small tile, so a list of accounts scans by provider. */
export function ProviderMark({
  className,
  muted = false,
  provider,
  size = "md",
}: {
  className?: string;
  muted?: boolean;
  provider: string;
  size?: "md" | "lg";
}) {
  const icon = size === "lg" ? 22 : 18;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-surface",
        size === "lg" ? "size-11" : "size-9",
        muted && "opacity-60 grayscale",
        className,
      )}
    >
      {provider === "google" ? <GoogleGlyph size={icon} /> : <Plug className="text-ink-3" size={icon - 2} />}
    </span>
  );
}

function GoogleGlyph({ size }: { size: number }) {
  return (
    <svg height={size} viewBox="0 0 24 24" width={size}>
      <path
        d="M21.6 12.23c0-.68-.06-1.36-.18-2.02H12v3.83h5.4a4.6 4.6 0 0 1-2 3.03v2.5h3.24c1.9-1.75 2.96-4.33 2.96-7.34Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.97-.9 6.63-2.43l-3.24-2.5c-.9.6-2.05.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.58A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path d="M6.4 13.91a6 6 0 0 1 0-3.82V7.51H3.06a10 10 0 0 0 0 8.98l3.34-2.58Z" fill="#FBBC04" />
      <path
        d="M12 5.98c1.47-.02 2.9.53 3.96 1.55l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.94 5.51L6.4 10.1C7.2 7.73 9.4 5.98 12 5.98Z"
        fill="#EA4335"
      />
    </svg>
  );
}
