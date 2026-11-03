"use client";

import Link from "@/ui/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Globe2, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AvatarColor, ArtifactStatus, Health, PageVisibility } from "@/features/console/types";

type ButtonProps = {
  href?: string;
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm" | "default";
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  children: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement> &
  AnchorHTMLAttributes<HTMLAnchorElement>;

export function Button({ href, variant = "default", size = "default", icon: Icon, iconRight: IconRight, children, className, ...rest }: ButtonProps) {
  const classes = cn(
    "btn",
    variant === "primary" && "btn--primary",
    variant === "ghost" && "btn--ghost",
    variant === "danger" && "btn--danger",
    size === "sm" && "btn--sm",
    className,
  );
  const content = (
    <>
      {Icon ? <Icon size={size === "sm" ? 12 : 13} /> : null}
      {children}
      {IconRight ? <IconRight size={size === "sm" ? 12 : 13} /> : null}
    </>
  );

  if (href) {
    return (
      <Link className={classes} href={href} {...rest}>
        {content}
      </Link>
    );
  }

  return (
    <button className={classes} type="button" {...rest}>
      {content}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className }: { icon: LucideIcon; label: string; className?: string }) {
  return (
    <button aria-label={label} className={cn("icon-btn", className)} title={label} type="button">
      <Icon size={14} />
    </button>
  );
}

export function Tag({
  tone = "default",
  dot,
  children,
}: {
  tone?: "default" | "ok" | "warn" | "err" | "info";
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cn("tag", tone !== "default" && `tag--${tone}`)}>
      {dot ? <span className={cn("dot", tone !== "default" && `dot--${tone}`)} /> : null}
      {children}
    </span>
  );
}

export function Avatar({ mark = "?", color = "c1", size }: { mark?: string; color?: AvatarColor; size?: "lg" | "xl" }) {
  return <span className={cn("avatar", `avatar--${color}`, size && `avatar--${size}`)}>{mark}</span>;
}

export function SlashMark({ label }: { num?: number; label: string }) {
  return <span className="slash-mark">{label}</span>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("card", className)}>{children}</section>;
}

export function CardHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card-hd">
      <div className="row grow">{children}</div>
      {right ? <div className="row gap-8">{right}</div> : null}
    </div>
  );
}

export function CardBody({ children, flush, className }: { children: ReactNode; flush?: boolean; className?: string }) {
  return <div className={cn("card-bd", flush && "card-bd--flush", className)}>{children}</div>;
}

export function PageHeader({
  slashNum,
  slashLabel,
  title,
  sub,
  right,
}: {
  slashNum: number;
  slashLabel: string;
  title: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <header className="page-header">
      <SlashMark label={slashLabel} num={slashNum} />
      <div className="page-header-main">
        <div className="page-header-copy col gap-8 grow">
          <h1 className="t-h1">{title}</h1>
          {sub ? <div className="t-mute t-body">{sub}</div> : null}
        </div>
        {right ? <div className="row gap-8">{right}</div> : null}
      </div>
    </header>
  );
}

export function StatusDot({ status }: { status: ArtifactStatus | Health | string }) {
  return <span className={cn("dot", `dot--${statusTone(status)}`)} />;
}

export function statusTone(status: ArtifactStatus | Health | string): "ok" | "warn" | "err" | "info" | "default" {
  switch (status) {
    case "deployed":
    case "verified":
    case "connected":
    case "active":
    case "ok":
    case "ready":
      return "ok";
    case "building":
    case "provisioning":
    case "qr_pending":
    case "pairing":
    case "queued":
    case "pending":
    case "warn":
      return "warn";
    case "failed":
    case "degraded":
    case "deleted":
    case "disabled":
    case "err":
    case "error":
      return "err";
    case "disconnected":
    case "created":
    case "preview":
    case "info":
      return "info";
    default:
      return "default";
  }
}

export function VisibilityTag({ value }: { value: PageVisibility }) {
  if (value === "public") {
    return (
      <Tag>
        <Globe2 size={10} /> public
      </Tag>
    );
  }
  if (value === "private") {
    return (
      <Tag>
        <Lock size={10} /> private
      </Tag>
    );
  }
  if (value === "password") {
    return (
      <Tag tone="warn">
        <KeyRound size={10} /> password
      </Tag>
    );
  }
  return (
    <Tag tone="info">
      <ShieldCheck size={10} /> protected
    </Tag>
  );
}

export function Metric({ label, value, sub, mono }: { label: string; value: ReactNode; sub: string; mono?: boolean }) {
  return (
    <div className="metric col gap-8">
      <div className="t-label">{label}</div>
      <div className="row gap-8" style={{ alignItems: "baseline" }}>
        <span className={cn("metric-value", mono && "t-mono")}>{value}</span>
        <span className="t-mute t-small">{sub}</span>
      </div>
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={value} role="progressbar">
      <span style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  );
}
