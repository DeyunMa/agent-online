import { Link } from "@tanstack/react-router";
import { ChartNoAxesColumn, LoaderCircle, LogOut, TerminalSquare } from "lucide-react";

export function AppHeader({
  email,
  isSigningOut,
  name,
  onContextSlotReady,
  onSignOut,
}: {
  email: string;
  isSigningOut: boolean;
  name: string;
  onContextSlotReady: (element: HTMLDivElement | null) => void;
  onSignOut: () => void;
}) {
  return (
    <header className="app-header">
      <Link aria-label="Agent Online projects" className="app-brand" to="/">
        <span className="app-brand-mark">
          <TerminalSquare aria-hidden="true" size={18} />
        </span>
        <span>Agent Online</span>
      </Link>

      <div className="app-header-context" ref={onContextSlotReady} />

      <div className="app-header-actions">
        <Link aria-label="Usage" className="icon-button app-header-usage" title="Usage" to="/usage">
          <ChartNoAxesColumn aria-hidden="true" size={17} />
        </Link>
        <span className="account-avatar" title={email}>
          {initials(name || email)}
        </span>
        <button
          aria-label="Sign out"
          className="icon-button"
          disabled={isSigningOut}
          onClick={onSignOut}
          title="Sign out"
          type="button"
        >
          {isSigningOut ? (
            <LoaderCircle aria-hidden="true" className="spin" size={17} />
          ) : (
            <LogOut aria-hidden="true" size={17} />
          )}
        </button>
      </div>
    </header>
  );
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const text =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : value.slice(0, 2);
  return text.toLocaleUpperCase() || "AO";
}
