import { Link } from "@tanstack/react-router";
import { TerminalSquare } from "lucide-react";

import { AccountMenu } from "./account-menu";

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
        <AccountMenu
          email={email}
          isSigningOut={isSigningOut}
          name={name}
          onSignOut={onSignOut}
          placement="header"
        />
      </div>
    </header>
  );
}
