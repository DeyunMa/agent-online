import "@xterm/xterm/css/xterm.css";

import type { FitAddon } from "@xterm/addon-fit";
import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";
import {
  LoaderCircle,
  PlugZap,
  Square,
  TerminalSquare,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  connectProjectTerminal,
  type BrowserTerminalConnection,
} from "../terminal-client";

type TerminalPhase =
  | "closed"
  | "closing"
  | "connecting"
  | "idle"
  | "loading"
  | "ready";

export function ProjectTerminal({
  active,
  hasActiveRun,
  onActivityChange,
  projectId,
}: {
  active: boolean;
  hasActiveRun: boolean;
  onActivityChange(active: boolean): void;
  projectId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connectionRef =
    useRef<BrowserTerminalConnection | null>(null);
  const connectionGenerationRef = useRef(0);
  const inputSubscriptionRef = useRef<IDisposable | null>(null);
  const onActivityChangeRef = useRef(onActivityChange);
  const [error, setError] = useState<Error | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [phase, setPhase] = useState<TerminalPhase>("loading");

  onActivityChangeRef.current = onActivityChange;

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ])
      .then(([xtermModule, fitModule]) => {
        if (cancelled || !containerRef.current) {
          return;
        }

        const terminal = new xtermModule.Terminal({
          allowProposedApi: false,
          convertEol: true,
          cursorBlink: true,
          cursorStyle: "block",
          fontFamily:
            '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
          fontSize: 11,
          lineHeight: 1.3,
          scrollback: 2_000,
          theme: {
            background: "#151715",
            black: "#151715",
            blue: "#79a8d8",
            brightBlack: "#777b75",
            brightBlue: "#9ec4e8",
            brightCyan: "#8fc9c5",
            brightGreen: "#a6c995",
            brightMagenta: "#c1a4cf",
            brightRed: "#e39b91",
            brightWhite: "#ffffff",
            brightYellow: "#dfc47b",
            cursor: "#f4f4ee",
            cyan: "#6eaaa6",
            foreground: "#e8e9e3",
            green: "#8aaf79",
            magenta: "#aa8db8",
            red: "#cb766d",
            selectionBackground: "#3c5044",
            white: "#d8dad4",
            yellow: "#c3a85f",
          },
        });
        const fitAddon = new fitModule.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        inputSubscriptionRef.current = terminal.onData((data) => {
          connectionRef.current?.write(data);
        });
        resizeObserver = new ResizeObserver(() => {
          const size = fitTerminal(terminal, fitAddon);
          if (size) {
            connectionRef.current?.resize(size.cols, size.rows);
          }
        });
        resizeObserver.observe(containerRef.current);
        setPhase("idle");
      })
      .catch(() => {
        if (!cancelled) {
          setError(new Error("终端界面加载失败，请刷新后重试。"));
          setPhase("closed");
        }
      });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      inputSubscriptionRef.current?.dispose();
      inputSubscriptionRef.current = null;
      connectionGenerationRef.current += 1;
      connectionRef.current?.dispose();
      connectionRef.current = null;
      fitAddonRef.current?.dispose();
      fitAddonRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      onActivityChangeRef.current(false);
    };
  }, [projectId]);

  useEffect(() => {
    if (!active || !terminalRef.current || !fitAddonRef.current) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const size = fitTerminal(
        terminalRef.current,
        fitAddonRef.current,
      );
      if (size) {
        connectionRef.current?.resize(size.cols, size.rows);
      }
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const connect = () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (
      !terminal ||
      !fitAddon ||
      hasActiveRun ||
      phase === "connecting" ||
      phase === "ready"
    ) {
      return;
    }

    connectionRef.current?.dispose();
    terminal.reset();
    setError(null);
    setExpiresAt(null);
    const size = fitTerminal(terminal, fitAddon) ?? {
      cols: 80,
      rows: 24,
    };
    setPhase("connecting");
    onActivityChangeRef.current(true);
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    const isCurrentConnection = () =>
      connectionGenerationRef.current === generation;
    try {
      connectionRef.current = connectProjectTerminal(
        projectId,
        size,
        {
          onClose() {
            if (!isCurrentConnection()) {
              return;
            }
            connectionRef.current = null;
            onActivityChangeRef.current(false);
            setPhase("closed");
          },
          onData(data) {
            if (isCurrentConnection()) {
              terminal.write(data);
            }
          },
          onError(nextError) {
            if (!isCurrentConnection()) {
              return;
            }
            setError(nextError);
            setPhase("closing");
          },
          onExit(exitCode) {
            if (!isCurrentConnection()) {
              return;
            }
            setPhase("closing");
            if (exitCode !== 0) {
              setError(
                new Error(`终端进程已退出（code ${exitCode}）。`),
              );
            }
          },
          onReady(nextExpiresAt) {
            if (!isCurrentConnection()) {
              return;
            }
            setExpiresAt(nextExpiresAt);
            setPhase("ready");
            terminal.focus();
          },
        },
      );
    } catch {
      connectionRef.current = null;
      setError(new Error("终端连接无法建立，请稍后重试。"));
      setPhase("closed");
      onActivityChangeRef.current(false);
    }
  };

  const close = () => {
    if (!connectionRef.current) {
      return;
    }
    setPhase("closing");
    connectionRef.current.close();
  };

  const canConnect =
    phase !== "loading" &&
    phase !== "connecting" &&
    phase !== "ready" &&
    phase !== "closing" &&
    !hasActiveRun;

  return (
    <section
      className="project-terminal-view"
      hidden={!active}
    >
      <div className="project-terminal-toolbar">
        <div
          aria-live="polite"
          className={`project-terminal-status terminal-status-${phase}`}
          title={
            expiresAt
              ? `Session expires ${new Date(expiresAt).toLocaleTimeString()}`
              : undefined
          }
        >
          <span aria-hidden="true" />
          {terminalPhaseLabel(phase)}
        </div>
        {phase === "ready" ||
        phase === "connecting" ||
        phase === "closing" ? (
          <button
            aria-label="Close terminal"
            className="project-terminal-action"
            onClick={close}
            title="Close terminal"
            type="button"
          >
            {phase === "closing" ? (
              <LoaderCircle
                aria-hidden="true"
                className="spin"
                size={14}
              />
            ) : (
              <Square aria-hidden="true" size={13} />
            )}
            <span>Close</span>
          </button>
        ) : (
          <button
            className="project-terminal-action"
            disabled={!canConnect}
            onClick={connect}
            type="button"
          >
            {phase === "loading" ? (
              <LoaderCircle
                aria-hidden="true"
                className="spin"
                size={14}
              />
            ) : (
              <PlugZap aria-hidden="true" size={14} />
            )}
            <span>Connect</span>
          </button>
        )}
      </div>

      {hasActiveRun ? (
        <div className="project-terminal-notice" role="status">
          <TerminalSquare aria-hidden="true" size={16} />
          <span>Terminal is unavailable during an active Agent Run.</span>
        </div>
      ) : null}
      {error ? (
        <div className="project-terminal-error" role="alert">
          {error.message}
        </div>
      ) : null}
      <div
        aria-label="Project terminal"
        className="project-terminal-canvas"
        ref={containerRef}
      />
    </section>
  );
}

function fitTerminal(
  terminal: XTerm | null,
  fitAddon: FitAddon | null,
) {
  if (!terminal || !fitAddon || terminal.element?.clientWidth === 0) {
    return null;
  }

  try {
    fitAddon.fit();
  } catch {
    return null;
  }

  return {
    cols: Math.min(240, Math.max(20, terminal.cols)),
    rows: Math.min(100, Math.max(5, terminal.rows)),
  };
}

function terminalPhaseLabel(phase: TerminalPhase) {
  switch (phase) {
    case "loading":
      return "Loading";
    case "idle":
      return "Disconnected";
    case "connecting":
      return "Connecting";
    case "ready":
      return "Connected";
    case "closing":
      return "Closing";
    case "closed":
      return "Closed";
  }
}
