import { Link } from "@tanstack/react-router";
import { ChartNoAxesColumn, ChevronUp, LoaderCircle, LogOut } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export type AccountMenuProps = {
  email: string;
  isSigningOut: boolean;
  name: string;
  onSignOut: () => void;
  placement: "header" | "sidebar";
};

export function AccountMenu({ email, isSigningOut, name, onSignOut, placement }: AccountMenuProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const displayName = name.trim() || email;

  useEffect(() => {
    if (!open) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`account-menu account-menu-${placement}`} ref={rootRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open account menu"
        className="account-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={email}
        type="button"
      >
        <span className="account-avatar" aria-hidden="true">
          {initials(displayName)}
        </span>
        <span className="account-menu-trigger-copy">
          <strong>{displayName}</strong>
          <span>{email}</span>
        </span>
        <ChevronUp aria-hidden="true" className="account-menu-chevron" size={15} />
      </button>

      {open ? (
        <div
          aria-label="Account"
          className="account-menu-popover"
          id={menuId}
          ref={menuRef}
          role="menu"
        >
          <div className="account-menu-identity">
            <strong>{displayName}</strong>
            <span>{email}</span>
          </div>
          <Link
            activeProps={{ className: "account-menu-item account-menu-item-active" }}
            className="account-menu-item"
            onClick={() => setOpen(false)}
            role="menuitem"
            to="/usage"
          >
            <ChartNoAxesColumn aria-hidden="true" size={16} />
            <span>Usage</span>
          </Link>
          <button
            className="account-menu-item"
            disabled={isSigningOut}
            onClick={onSignOut}
            role="menuitem"
            type="button"
          >
            {isSigningOut ? (
              <LoaderCircle aria-hidden="true" className="spin" size={16} />
            ) : (
              <LogOut aria-hidden="true" size={16} />
            )}
            <span>{isSigningOut ? "Signing out" : "Sign out"}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const text =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : value.slice(0, 2);
  return text.toLocaleUpperCase() || "AO";
}
