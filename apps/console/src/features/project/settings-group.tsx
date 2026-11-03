import { cn } from "@/lib/cn";

const grid = "grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-x-10";

/** A titled group of settings: what it is on the left, the content on the right. Stacks on phones. */
export function SettingsGroup({
  children,
  className,
  description,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <section className={cn(grid, className)}>
      <div className="space-y-1">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description ? <div className="text-sm text-ink-3">{description}</div> : null}
      </div>
      <div className="min-w-0 max-w-[720px] space-y-4">{children}</div>
    </section>
  );
}

/** Content aligned with the right column of the groups above, without a title (a save bar, a footnote). */
export function SettingsGroupAside({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(grid, className)}>
      <div aria-hidden className="hidden lg:block" />
      <div className="min-w-0 max-w-[720px]">{children}</div>
    </div>
  );
}
