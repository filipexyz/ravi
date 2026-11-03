import Link from "@/ui/link";

import { RaviMark } from "@/features/shell/app-shell";
import { cn } from "@/lib/cn";

const widths = {
  sm: "max-w-[440px]",
  md: "max-w-[520px]",
  lg: "max-w-[680px]",
  /** As wide as the top bar, for content that needs room, like a recorded meeting. */
  xl: "max-w-[1120px]",
} as const;

/**
 * Frame for pages that open outside the Console shell: sign-in, the CLI and
 * chat-link approvals, the global 404. Brand on top, one centered column.
 */
export function StandaloneFrame({
  aside,
  brand: showBrand = true,
  children,
  homeHref = "/projects",
  width = "md",
}: {
  /** Right side of the top bar, such as who is signed in. */
  aside?: React.ReactNode;
  /** False when the page shows the brand itself, like the sign-in card. */
  brand?: boolean;
  children: React.ReactNode;
  /** Where the brand links to; null renders the brand without a link. */
  homeHref?: string | null;
  width?: keyof typeof widths;
}) {
  const brand = (
    <>
      <RaviMark />
      <span className="text-sm font-semibold text-ink">Ravi Console</span>
    </>
  );
  return (
    <div className="rv-app flex min-h-dvh flex-col bg-canvas font-sans text-ink antialiased">
      <header className="mx-auto flex h-14 w-full max-w-[1120px] items-center justify-between gap-3 px-4 sm:px-6">
        {!showBrand ? (
          <span />
        ) : homeHref ? (
          <Link aria-label="Ravi Console home" className="flex items-center gap-2.5" href={homeHref}>
            {brand}
          </Link>
        ) : (
          <div className="flex items-center gap-2.5">{brand}</div>
        )}
        {aside ? <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink-3">{aside}</div> : null}
      </header>
      <main
        className={cn("flex flex-1 flex-col items-center px-4 pb-16 sm:px-6", showBrand ? "pt-8 sm:pt-16" : "pt-10 sm:pt-[12vh]")}
        id="main"
      >
        <div className={cn("w-full", widths[width])}>{children}</div>
      </main>
      <footer className="flex justify-center px-4 pb-6 text-xs text-ink-2">
        <a className="transition-colors hover:text-ink" href="https://docs.ravi.bot" rel="noreferrer" target="_blank">
          Ravi docs
        </a>
      </footer>
    </div>
  );
}

/** "Signed in as …" with a way out, for approval pages where the account matters. */
export function SignedInAs({ email, name }: { email: string; name?: string }) {
  return (
    <>
      <span className="hidden truncate sm:inline" title={name && name !== email ? `${name} (${email})` : email}>
        Signed in as <span className="text-ink-2">{email}</span>
      </span>
      <a
        className="inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        href="/logout"
      >
        Sign out
      </a>
    </>
  );
}
