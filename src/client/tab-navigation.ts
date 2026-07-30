import type { KeyboardEvent } from "react";

export function handleRovingTabKeyDown(event: KeyboardEvent<HTMLElement>) {
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
  );
  const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = getNextTabIndex(event.key, currentIndex, tabs.length);
  if (nextIndex === null) {
    return;
  }

  event.preventDefault();
  const nextTab = tabs[nextIndex];
  nextTab?.focus();
  nextTab?.click();
  window.requestAnimationFrame(() => {
    if (nextTab?.isConnected) {
      nextTab.focus({ preventScroll: true });
    }
  });
}

export function getNextTabIndex(key: string, currentIndex: number, tabCount: number) {
  if (tabCount < 1) {
    return null;
  }

  switch (key) {
    case "ArrowLeft":
      return currentIndex <= 0 ? tabCount - 1 : currentIndex - 1;
    case "ArrowRight":
      return currentIndex < 0 || currentIndex >= tabCount - 1 ? 0 : currentIndex + 1;
    case "Home":
      return 0;
    case "End":
      return tabCount - 1;
    default:
      return null;
  }
}
