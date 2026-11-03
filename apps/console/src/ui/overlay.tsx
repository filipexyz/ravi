"use client";

import Link from "@/ui/link";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { IconButton } from "./button";

function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  // Dialogs are often unmounted while open. Closing first, while the element is
  // still in the page, lets the browser return focus to what opened it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onClose]);
  const onBackdropClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  return { onBackdropClick, ref };
}

/** Centered modal for confirmations and short forms. */
export function Dialog({
  children,
  className,
  description,
  footer,
  onClose,
  open,
  title,
}: {
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  open: boolean;
  title: React.ReactNode;
}) {
  const { onBackdropClick, ref } = useModalDialog(open, onClose);
  const titleId = useId();
  return (
    <dialog
      aria-labelledby={titleId}
      className={cn(
        "m-auto w-[calc(100%-32px)] max-w-md rounded-xl border border-line bg-surface p-0 text-ink shadow-pop",
        className,
      )}
      onClick={onBackdropClick}
      ref={ref}
    >
      {open ? (
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-ink" id={titleId}>
                {title}
              </h2>
              {description ? <div className="text-sm text-ink-2">{description}</div> : null}
            </div>
            <IconButton className="-mt-1 -mr-2" icon={X} label="Close" onClick={onClose} size="sm" />
          </div>
          {children ? <div className={cn("px-5 pt-4", !footer && "pb-5")}>{children}</div> : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 px-5 pt-5 pb-5">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Side panel for the details of one row. Full width on phones. */
export function Drawer({
  actions,
  children,
  description,
  onClose,
  open,
  title,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
  open: boolean;
  title: React.ReactNode;
}) {
  const { onBackdropClick, ref } = useModalDialog(open, onClose);
  const titleId = useId();
  return (
    <dialog
      aria-labelledby={titleId}
      className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-[520px] border-l border-line bg-surface p-0 text-ink shadow-pop"
      onClick={onBackdropClick}
      ref={ref}
    >
      {open ? (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0 space-y-1">
              <h2 className="truncate text-base font-semibold text-ink" id={titleId}>
                {title}
              </h2>
              {description ? <div className="truncate text-sm text-ink-3">{description}</div> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {actions}
              <IconButton icon={X} label="Close" onClick={onClose} size="sm" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

type MenuContextValue = { close: () => void };
const MenuContext = createContext<MenuContextValue | null>(null);

/**
 * Dropdown menu. `trigger` receives the props for the button that opens it.
 * Closes on outside click, Escape, and after an item runs.
 */
export function Menu({
  align = "start",
  children,
  className,
  label,
  trigger,
}: {
  align?: "start" | "end";
  children: React.ReactNode;
  className?: string;
  label: string;
  trigger: (props: {
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
    "aria-controls": string;
    onClick: () => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
  }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        (rootRef.current?.querySelector("[aria-haspopup]") as HTMLElement | null)?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const first = panelRef.current?.querySelector<HTMLElement>("[data-autofocus], [role=menuitem]");
    first?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const onPanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <MenuContext.Provider value={{ close }}>
      <div className="relative" ref={rootRef}>
        {trigger({
          "aria-controls": menuId,
          "aria-expanded": open,
          "aria-haspopup": "menu",
          onClick: () => setOpen((value) => !value),
          onKeyDown: (event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
            }
          },
        })}
        {open ? (
          <div
            aria-label={label}
            className={cn(
              "absolute top-full z-50 mt-1.5 max-h-[min(70vh,520px)] min-w-56 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-pop",
              align === "end" ? "right-0" : "left-0",
              className,
            )}
            id={menuId}
            onKeyDown={onPanelKeyDown}
            ref={panelRef}
            role="menu"
          >
            {children}
          </div>
        ) : null}
      </div>
    </MenuContext.Provider>
  );
}

function useMenuClose() {
  return useContext(MenuContext)?.close ?? (() => {});
}

const itemClass =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-ink outline-none transition-colors " +
  "hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50";

export function MenuItem({
  children,
  description,
  external,
  href,
  icon: Icon,
  onSelect,
  selected,
  tone,
}: {
  children: React.ReactNode;
  description?: React.ReactNode;
  external?: boolean;
  href?: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  selected?: boolean;
  tone?: "danger";
}) {
  const close = useMenuClose();
  const content = (
    <>
      {Icon ? <Icon aria-hidden className="shrink-0 text-ink-3" size={16} /> : null}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", tone === "danger" && "text-err", selected && "font-medium")}>{children}</span>
        {description ? <span className="block truncate text-xs text-ink-3">{description}</span> : null}
      </span>
      {selected ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ok" /> : null}
    </>
  );
  if (href) {
    if (external) {
      return (
        <a className={itemClass} href={href} onClick={close} role="menuitem" tabIndex={-1}>
          {content}
        </a>
      );
    }
    return (
      <Link className={itemClass} href={href} onClick={close} role="menuitem" tabIndex={-1}>
        {content}
      </Link>
    );
  }
  return (
    <button
      className={itemClass}
      onClick={() => {
        close();
        onSelect?.();
      }}
      role="menuitem"
      tabIndex={-1}
      type="button"
    >
      {content}
    </button>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-ink-3">{children}</div>;
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-line" role="separator" />;
}

/** Arbitrary content inside a menu (a search box, a form). */
export function MenuSlot({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-1 py-1", className)}>{children}</div>;
}
