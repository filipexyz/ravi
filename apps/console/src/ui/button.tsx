"use client";

import Link from "@/ui/link";
import { forwardRef } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors " +
  "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-hover",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
  danger: "border border-line-strong bg-surface text-err hover:bg-err-soft",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-[13px]",
  md: "h-9 px-3.5 text-sm",
};

export function buttonClass({
  className,
  size = "md",
  variant = "secondary",
}: {
  className?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}) {
  return cn(base, variants[variant], sizes[size], className);
}

type CommonProps = {
  children?: React.ReactNode;
  className?: string;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

type ButtonAsButton = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & { href?: undefined };

type ButtonAsLink = CommonProps & {
  href: string;
  /** Plain anchor for API routes and full page loads (auth, OAuth, downloads). */
  external?: boolean;
  target?: string;
  rel?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  "aria-label"?: string;
  title?: string;
  prefetch?: boolean;
};

export type ButtonProps = ButtonAsButton | ButtonAsLink;

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(props, ref) {
  const { children, className, icon: Icon, iconRight: IconRight, loading, size = "md", variant = "secondary" } = props;
  const iconSize = size === "sm" ? 14 : 16;
  const content = (
    <>
      {loading ? <Loader2 aria-hidden className="animate-spin" size={iconSize} /> : Icon ? <Icon aria-hidden size={iconSize} /> : null}
      {children}
      {IconRight ? <IconRight aria-hidden size={iconSize} /> : null}
    </>
  );
  const classes = buttonClass({ className, size, variant });

  if (props.href !== undefined) {
    const { external, href, onClick, prefetch, rel, target, title } = props;
    if (external || target) {
      return (
        <a
          aria-label={props["aria-label"]}
          className={classes}
          href={href}
          onClick={onClick}
          ref={ref as React.Ref<HTMLAnchorElement>}
          rel={rel ?? (target === "_blank" ? "noreferrer" : undefined)}
          target={target}
          title={title}
        >
          {content}
        </a>
      );
    }
    return (
      <Link
        aria-label={props["aria-label"]}
        className={classes}
        href={href}
        onClick={onClick}
        prefetch={prefetch}
        ref={ref as React.Ref<HTMLAnchorElement>}
        title={title}
      >
        {content}
      </Link>
    );
  }

  const {
    children: _children,
    className: _className,
    icon: _icon,
    iconRight: _iconRight,
    loading: _loading,
    size: _size,
    variant: _variant,
    disabled,
    type,
    ...rest
  } = props;
  return (
    <button
      {...rest}
      aria-busy={loading || undefined}
      className={classes}
      disabled={disabled || loading}
      ref={ref as React.Ref<HTMLButtonElement>}
      type={type ?? "button"}
    >
      {content}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    icon: LucideIcon;
    label: string;
    size?: ButtonSize;
    variant?: Exclude<ButtonVariant, "primary">;
  }
>(function IconButton({ className, icon: Icon, label, size = "md", type, variant = "ghost", ...rest }, ref) {
  return (
    <button
      {...rest}
      aria-label={label}
      className={cn(
        base,
        variants[variant],
        size === "sm" ? "size-8" : "size-9",
        className,
      )}
      ref={ref}
      title={rest.title ?? label}
      type={type ?? "button"}
    >
      <Icon aria-hidden size={size === "sm" ? 15 : 17} />
    </button>
  );
});
