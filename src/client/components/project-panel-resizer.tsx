import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const inspectorWidthStorageKey = "agent-online:project-inspector-drawer-width";
const minimumInspectorWidth = 360;
const narrowInspectorWidth = 280;
const maximumInspectorWidth = 720;
const minimumConsoleWidth = 420;
const resizeHandleWidth = 8;
const keyboardResizeStep = 16;

type InspectorLayout = {
  max: number;
  min: number;
  width: number;
};

export function ProjectPanelResizer({
  containerRef,
  open,
}: {
  containerRef: RefObject<HTMLElement | null>;
  open: boolean;
}) {
  const preferredWidthRef = useRef<number | null>(null);
  const resizingRef = useRef(false);
  const [layout, setLayout] = useState<InspectorLayout>({
    max: maximumInspectorWidth,
    min: minimumInspectorWidth,
    width: 320,
  });

  const applyWidth = useCallback(
    (requestedWidth: number, persist: boolean) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const bounds = inspectorWidthBounds(container.clientWidth);
      const width = clampInspectorWidth(requestedWidth, bounds);
      document.documentElement.style.setProperty("--inspector-width", `${width}px`);
      setLayout({ ...bounds, width });
      if (persist) {
        preferredWidthRef.current = width;
        writeStoredInspectorWidth(width);
      }
    },
    [containerRef],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const computedWidth = Number.parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue("--inspector-width"),
    );
    preferredWidthRef.current =
      readStoredInspectorWidth() ??
      (Number.isFinite(computedWidth) ? computedWidth : defaultInspectorWidth());

    const syncWidth = () => {
      applyWidth(preferredWidthRef.current ?? defaultInspectorWidth(), false);
    };
    const observer = new ResizeObserver(syncWidth);
    observer.observe(container);
    syncWidth();

    return () => {
      observer.disconnect();
      document.body.classList.remove("project-panels-resizing");
      document.documentElement.style.removeProperty("--inspector-width");
    };
  }, [applyWidth, containerRef]);

  const resizeFromPointer = useCallback(
    (clientX: number) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      applyWidth(container.getBoundingClientRect().right - clientX, true);
    },
    [applyWidth, containerRef],
  );

  function finishResize(event: PointerEvent<HTMLDivElement>) {
    if (!resizingRef.current) {
      return;
    }
    resizingRef.current = false;
    document.body.classList.remove("project-panels-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? keyboardResizeStep * 2 : keyboardResizeStep;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = layout.width + step;
    } else if (event.key === "ArrowRight") {
      nextWidth = layout.width - step;
    } else if (event.key === "Home") {
      nextWidth = layout.min;
    } else if (event.key === "End") {
      nextWidth = layout.max;
    }
    if (nextWidth === null) {
      return;
    }
    event.preventDefault();
    applyWidth(nextWidth, true);
  }

  return (
    <hr
      aria-controls="project-console-main project-inspector"
      aria-label="Resize project inspector"
      aria-orientation="vertical"
      aria-valuemax={layout.max}
      aria-valuemin={layout.min}
      aria-valuenow={layout.width}
      className="project-panel-resizer"
      hidden={!open}
      onDoubleClick={() => {
        applyWidth(defaultInspectorWidth(), true);
      }}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={(event) => finishResize(event)}
      onPointerCancel={(event) => finishResize(event)}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        resizingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add("project-panels-resizing");
        resizeFromPointer(event.clientX);
      }}
      onPointerMove={(event) => {
        if (resizingRef.current) {
          resizeFromPointer(event.clientX);
        }
      }}
      onPointerUp={(event) => finishResize(event)}
      tabIndex={0}
      title="Resize project inspector"
    />
  );
}

export function inspectorWidthBounds(containerWidth: number) {
  const responsiveMaximum = containerWidth - minimumConsoleWidth - resizeHandleWidth;
  const max = Math.min(maximumInspectorWidth, Math.max(narrowInspectorWidth, responsiveMaximum));
  return {
    max,
    min: Math.min(minimumInspectorWidth, max),
  };
}

export function clampInspectorWidth(
  width: number,
  bounds: ReturnType<typeof inspectorWidthBounds>,
) {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

function defaultInspectorWidth() {
  return window.matchMedia("(max-width: 1120px)").matches ? 420 : 480;
}

function readStoredInspectorWidth() {
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(inspectorWidthStorageKey) ?? "");
    return Number.isFinite(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredInspectorWidth(width: number) {
  try {
    window.localStorage.setItem(inspectorWidthStorageKey, String(width));
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}
