import { cn } from "@/lib/cn";

/** Page title block: the biggest thing on the screen is what the page is about. */
export function PageHeader({
  actions,
  children,
  className,
  description,
  title,
}: {
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <header className={cn("mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 space-y-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <div className="max-w-2xl text-sm text-ink-2">{description}</div> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A titled block inside a page. */
export function Section({
  actions,
  children,
  className,
  description,
  id,
  title,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  id?: string;
  title?: React.ReactNode;
}) {
  return (
    <section className={cn("space-y-3", className)} id={id}>
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            {title ? <h2 className="text-[15px] font-semibold text-ink">{title}</h2> : null}
            {description ? <div className="text-sm text-ink-3">{description}</div> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Bordered surface. Lists, forms and empty states sit inside one. */
export function Panel({
  as: Tag = "div",
  children,
  className,
  padded = false,
}: {
  as?: "div" | "section" | "article";
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <Tag className={cn("overflow-hidden rounded-lg border border-line bg-surface", padded && "p-5", className)}>
      {children}
    </Tag>
  );
}

/** Label/value pairs, used in drawers and summaries. */
export function DetailList({
  className,
  items,
}: {
  className?: string;
  items: Array<{ label: React.ReactNode; value: React.ReactNode; key?: string } | null | false | undefined>;
}) {
  return (
    <dl className={cn("divide-y divide-line", className)}>
      {items.filter(Boolean).map((item, index) => {
        const entry = item as { label: React.ReactNode; value: React.ReactNode; key?: string };
        return (
          <div className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4" key={entry.key ?? index}>
            <dt className="text-sm text-ink-3">{entry.label}</dt>
            <dd className="min-w-0 text-sm text-ink">{entry.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[13px]", className)}>{children}</span>;
}
