import { Link } from "@tanstack/react-router";
import { ChartNoAxesColumn, ChevronUp, LoaderCircle, LogOut } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type AccountMenuProps = {
  email: string;
  isSigningOut: boolean;
  name: string;
  onSignOut: () => void;
  placement: "header" | "sidebar";
};

export function AccountMenu({ email, isSigningOut, name, onSignOut, placement }: AccountMenuProps) {
  const displayName = name.trim() || email;

  return (
    <div
      className={cn("account-menu", {
        "account-menu-header": placement === "header",
        "account-menu-sidebar": placement === "sidebar",
      })}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Open account menu"
          className="account-menu-trigger"
          title={email}
        >
          <span className="account-avatar" aria-hidden="true">
            {initials(displayName)}
          </span>
          <span className="account-menu-trigger-copy">
            <strong>{displayName}</strong>
            <span>{email}</span>
          </span>
          <ChevronUp aria-hidden="true" className="account-menu-chevron" size={15} />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align={placement === "header" ? "end" : "start"}
          aria-label="Account"
          className="account-menu-popover"
          side={placement === "header" ? "bottom" : "top"}
          sideOffset={8}
        >
          <div className="account-menu-identity">
            <strong>{displayName}</strong>
            <span>{email}</span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem className="min-h-9" render={<Link to="/usage" />}>
              <ChartNoAxesColumn aria-hidden="true" size={16} />
              <span>Usage</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-9" render={<Link to="/settings/connections" />}>
              <span>Connected apps</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-9" disabled={isSigningOut} onClick={onSignOut}>
              {isSigningOut ? (
                <LoaderCircle aria-hidden="true" className="spin" size={16} />
              ) : (
                <LogOut aria-hidden="true" size={16} />
              )}
              <span>{isSigningOut ? "Signing out" : "Sign out"}</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const text =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : value.slice(0, 2);
  return text.toLocaleUpperCase() || "AO";
}
