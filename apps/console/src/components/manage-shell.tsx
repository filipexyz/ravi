"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Inbox, Laptop, LogOut, Shield } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Avatar } from "./ui";
import { cn } from "@/lib/cn";
import type { ConsoleViewer } from "@/lib/auth/session";
import { ToastProvider } from "@/ui/toast";

const MANAGE_NAV = [
  { key: "clients", label: "Clients", href: "/manage/clients", icon: Building2 },
  { key: "installations", label: "Installations", href: "/manage/installations", icon: Laptop },
  { key: "bugs", label: "Bug ops", href: "/manage/bugs", icon: Inbox },
] as const;

export function ManageFrame({
  children,
  viewer,
}: {
  children: React.ReactNode;
  viewer: ConsoleViewer;
}) {
  const pathname = usePathname();

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="side-brand" href="/manage">
          <span className="side-brand-mark">R</span>
          <span className="side-brand-name">ravi / manage</span>
        </Link>

        <div className="side-org" title="Platform management">
          <Avatar color="c5" mark="M" />
          <div className="grow">
            <div className="side-org-name">Management</div>
            <div className="side-org-plan">platform operator</div>
          </div>
          <Shield size={12} style={{ color: "var(--mute)" }} />
        </div>

        <div className="side-sect">
          <span>modules</span>
        </div>
        <nav className="side-nav">
          {MANAGE_NAV.map((item) => (
            <NavLink
              href={item.href}
              icon={item.icon}
              isActive={pathname === item.href || pathname.startsWith(`${item.href}/`)}
              key={item.key}
              label={item.label}
            />
          ))}
        </nav>

        <div className="side-foot">
          <Link className="side-user" href="/projects" title="Back to Console">
            <Avatar color="c1" mark="C" />
            <div className="grow truncate">
              <div className="side-user-name">Console</div>
              <div className="side-user-email truncate">organization workspace</div>
            </div>
          </Link>
          <a className="side-user" href="/logout" title="Sign out">
            <Avatar color="c5" mark={viewer.mark} />
            <div className="grow truncate">
              <div className="side-user-name">{viewer.name}</div>
              <div className="side-user-email truncate">{viewer.email}</div>
            </div>
            <LogOut size={13} style={{ color: "var(--mute)" }} />
          </a>
        </div>
      </aside>
      <main className="main-col">
        <div className="topbar">
          <div className="crumbs grow">
            {breadcrumbs(pathname).map((crumb, index) => (
              <span className="row gap-8" key={`${crumb.label}-${index}`}>
                {index > 0 ? <span className="sep">/</span> : null}
                {crumb.href ? (
                  <Link className={crumb.muted ? "muted" : undefined} href={crumb.href}>
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={crumb.muted ? "muted" : undefined}>{crumb.label}</span>
                )}
              </span>
            ))}
          </div>
        </div>
        <div className="content rv-legacy-dark">
          <ToastProvider>{children}</ToastProvider>
        </div>
      </main>
    </div>
  );
}

function NavLink({ href, icon: Icon, isActive: active, label }: { href: string; icon: LucideIcon; isActive: boolean; label: string }) {
  return (
    <Link className={cn(active && "is-active")} href={href}>
      <Icon />
      <span>{label}</span>
    </Link>
  );
}

function breadcrumbs(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "manage" && parts[1] === "bugs") {
    return [
      { label: "Manage", href: "/manage", muted: true },
      { label: "bug ops", href: "/manage/bugs", muted: Boolean(parts[2]) },
      ...(parts[2] ? [{ label: "report" }] : []),
    ];
  }
  if (parts[0] === "manage" && parts[1] === "clients") {
    return [
      { label: "Manage", href: "/manage", muted: true },
      { label: "clients", href: "/manage/clients", muted: Boolean(parts[2]) },
      ...(parts[2] ? [{ label: "client" }] : []),
    ];
  }
  if (parts[0] === "manage" && parts[1] === "installations") {
    return [{ label: "Manage", href: "/manage", muted: true }, { label: "installations" }];
  }
  return [{ label: "Manage", href: "/manage", muted: true }, { label: "modules" }];
}
