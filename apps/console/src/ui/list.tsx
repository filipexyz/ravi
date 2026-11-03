import Link from "@/ui/link";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

/** A divided list inside a bordered surface. One row per thing. */
export function List({ children, className, label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <ul aria-label={label} className={cn("divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface", className)}>
      {children}
    </ul>
  );
}

/**
 * One row: a leading visual, the main text, optional meta, and actions on the
 * right. With `href` or `onClick` the main area becomes the target; actions
 * stay separately clickable.
 */
export function ListRow({
  actions,
  chevron,
  className,
  description,
  href,
  leading,
  meta,
  onClick,
  selected,
  title,
}: {
  actions?: React.ReactNode;
  chevron?: boolean;
  className?: string;
  description?: React.ReactNode;
  href?: string;
  leading?: React.ReactNode;
  meta?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  title: React.ReactNode;
}) {
  const body = (
    <>
      {leading ? <div className="flex shrink-0 items-center">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{title}</div>
        {description ? <div className="mt-0.5 truncate text-[13px] text-ink-3">{description}</div> : null}
      </div>
      {meta ? <div className="hidden shrink-0 items-center gap-3 text-[13px] text-ink-3 md:flex">{meta}</div> : null}
      {chevron ? <ChevronRight aria-hidden className="shrink-0 text-ink-3" size={16} /> : null}
    </>
  );
  const interactive = "flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left";

  return (
    <li className={cn("group flex items-center transition-colors", (href || onClick) && "hover:bg-hover", selected && "bg-hover", className)}>
      {href ? (
        <Link className={interactive} href={href}>
          {body}
        </Link>
      ) : onClick ? (
        <button className={interactive} onClick={onClick} type="button">
          {body}
        </button>
      ) : (
        <div className={interactive}>{body}</div>
      )}
      {actions ? <div className="flex shrink-0 items-center gap-1 pr-3">{actions}</div> : null}
    </li>
  );
}
