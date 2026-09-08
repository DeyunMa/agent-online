import { type ReactNode, useLayoutEffect } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";

/** The same panels remain mounted when the inspector becomes a mobile dialog. */
export function ProjectPanels({
  children,
  inspector,
  mobile,
  onInspectorClose,
  open,
}: {
  children: ReactNode;
  inspector: ReactNode;
  mobile: boolean;
  onInspectorClose(): void;
  open: boolean;
}) {
  const inspectorPanel = usePanelRef();
  const desktopOpen = open && !mobile;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "agent-online:project-panels",
    panelIds: ["project-main-panel", "project-inspector-panel"],
    onlySaveAfterUserInteractions: true,
  });

  useLayoutEffect(() => {
    if (desktopOpen) {
      // Disabling the group re-registers panels, so expand() alone loses its
      // remembered size. Restore the preference returned by the library hook.
      const savedSize = defaultLayout?.["project-inspector-panel"];
      inspectorPanel.current?.resize(savedSize === undefined ? "480px" : `${savedSize}%`);
    } else inspectorPanel.current?.collapse();
  }, [defaultLayout, desktopOpen, inspectorPanel]);

  return (
    <ResizablePanelGroup
      className="project-console"
      defaultLayout={defaultLayout}
      disabled={!desktopOpen}
      id="project-panels"
      onLayoutChanged={(layout, meta) => {
        // Opening, closing and viewport changes must not replace the user's desktop preference.
        if (desktopOpen && (layout["project-inspector-panel"] ?? 0) > 0)
          onLayoutChanged(layout, meta);
        else if (desktopOpen && meta.isUserInteraction) onInspectorClose();
      }}
      orientation="horizontal"
    >
      <ResizablePanel id="project-main-panel" minSize="40%" className="project-main-panel">
        {children}
      </ResizablePanel>
      <ResizableHandle
        aria-label="Resize project inspector"
        className="project-panel-resizer"
        disabled={!desktopOpen}
        hidden={!desktopOpen}
        style={{ display: desktopOpen ? undefined : "none" }}
        title="Resize project inspector"
      />
      <ResizablePanel
        id="project-inspector-panel"
        panelRef={inspectorPanel}
        className="project-inspector-panel"
        collapsible
        collapsedSize={0}
        defaultSize="480px"
        groupResizeBehavior="preserve-pixel-size"
        minSize="280px"
        maxSize="720px"
      >
        {inspector}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
