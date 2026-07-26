import {
  createContext,
  type ReactNode,
  useContext,
} from "react";
import { createPortal } from "react-dom";

const AppHeaderSlotContext = createContext<HTMLElement | null>(null);

export function AppHeaderSlotProvider({
  children,
  target,
}: {
  children: ReactNode;
  target: HTMLElement | null;
}) {
  return (
    <AppHeaderSlotContext.Provider value={target}>
      {children}
    </AppHeaderSlotContext.Provider>
  );
}

export function AppHeaderSlot({ children }: { children: ReactNode }) {
  const target = useContext(AppHeaderSlotContext);
  return target ? createPortal(children, target) : null;
}
