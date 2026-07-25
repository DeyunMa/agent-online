import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Activity, FolderKanban, Plus, Settings, TerminalSquare } from "lucide-react";

import type { HealthResponse } from "../shared/api";

async function getHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");

  if (!response.ok) {
    throw new Error("Unable to reach the Agent Online Worker API.");
  }

  return response.json() as Promise<HealthResponse>;
}

function AppShell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <TerminalSquare aria-hidden="true" size={20} />
          <span>Agent Online</span>
        </Link>

        <nav aria-label="主导航" className="nav-list">
          <Link activeProps={{ className: "nav-item nav-item-active" }} className="nav-item" to="/">
            <FolderKanban aria-hidden="true" size={17} />
            <span>项目</span>
          </Link>
          <button className="nav-item" type="button">
            <Activity aria-hidden="true" size={17} />
            <span>用量</span>
          </button>
          <button className="nav-item" type="button">
            <Settings aria-hidden="true" size={17} />
            <span>设置</span>
          </button>
        </nav>

        <div className="sidebar-footer">开发基线</div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">AGENT ONLINE</p>
            <h1>项目</h1>
          </div>
          <button className="primary-action" type="button">
            <Plus aria-hidden="true" size={17} />
            <span>新建项目</span>
          </button>
        </header>
        <Outlet />
      </main>
    </div>
  );
}

function Dashboard() {
  const health = useQuery({ queryFn: getHealth, queryKey: ["health"] });

  return (
    <section className="dashboard-grid">
      <div className="workspace-list" aria-label="项目列表">
        <div className="section-heading">
          <div>
            <p className="section-kicker">WORKSPACE</p>
            <h2>你的项目</h2>
          </div>
          <span className="count">0</span>
        </div>
        <div className="empty-state">
          <FolderKanban aria-hidden="true" size={28} strokeWidth={1.5} />
          <p>项目将在这里出现。</p>
        </div>
      </div>

      <aside className="runtime-panel">
        <p className="section-kicker">RUNTIME</p>
        <h2>控制平面</h2>
        <dl className="runtime-status">
          <div>
            <dt>Worker API</dt>
            <dd className={health.isSuccess ? "status-ok" : "status-pending"}>
              {health.isSuccess ? "已连接" : health.isError ? "不可用" : "检查中"}
            </dd>
          </div>
          <div>
            <dt>沙箱策略</dt>
            <dd>每项目一个活动 Lease</dd>
          </div>
          <div>
            <dt>Agent Runtime</dt>
            <dd>Pi（默认）</dd>
          </div>
          <div>
            <dt>持久化</dt>
            <dd>D1（工作区仅在沙箱中）</dd>
          </div>
        </dl>
      </aside>
    </section>
  );
}

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  component: Dashboard,
  getParentRoute: () => rootRoute,
  path: "/",
});
const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
