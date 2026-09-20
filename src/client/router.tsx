import { useQueryClient } from "@tanstack/react-query";
import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { authClient } from "./auth";
import { AppHeader } from "./components/app-header";
import { AppHeaderSlotProvider } from "./components/app-header-slot";
import { AuthGate, AuthLoadingScreen, authErrorMessage } from "./components/auth-gate";
import { CreateProjectPage } from "./components/create-project-page";
import { ProjectDashboard } from "./components/project-dashboard";
import { ProjectSidebar } from "./components/project-sidebar";
import { LoadingState } from "./components/ui-states";
import { McpAuthorization } from "./components/mcp-authorization";
import { McpConnections } from "./components/mcp-connections";

// Start route downloads only when the authenticated shell renders its outlet.
const ProjectConsole = lazy(() =>
  import("./components/project-console").then((module) => ({ default: module.ProjectConsole })),
);
const UsagePage = lazy(() =>
  import("./components/usage-page").then((module) => ({ default: module.UsagePage })),
);

function AppShell() {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  async function signOut() {
    setIsSigningOut(true);
    setSignOutError(null);

    try {
      const result = await authClient.signOut();
      if (result.error) {
        setSignOutError(authErrorMessage(result.error));
        return;
      }

      queryClient.clear();
      await session.refetch();
    } catch {
      setSignOutError("Could not sign out. Try again.");
    } finally {
      setIsSigningOut(false);
    }
  }

  if (session.isPending) {
    return <AuthLoadingScreen />;
  }

  if (!session.data) {
    return (
      <AuthGate
        onAuthenticated={session.refetch}
        sessionError={session.error ? authErrorMessage(session.error) : null}
      />
    );
  }

  return (
    <div className="app-shell">
      <AppHeader
        email={session.data.user.email}
        isSigningOut={isSigningOut}
        name={session.data.user.name || session.data.user.email}
        onContextSlotReady={setHeaderSlot}
        onSignOut={() => void signOut()}
      />
      <ProjectSidebar
        email={session.data.user.email}
        isSigningOut={isSigningOut}
        name={session.data.user.name || session.data.user.email}
        onSignOut={() => void signOut()}
      />
      <div className="main-content">
        {signOutError ? (
          <p className="global-notice" role="alert">
            {signOutError}
          </p>
        ) : null}
        <AppHeaderSlotProvider target={headerSlot}>
          <Suspense fallback={<LoadingState label="Loading page" />}>
            <Outlet />
          </Suspense>
        </AppHeaderSlotProvider>
      </div>
    </div>
  );
}

function ProjectPage() {
  const { projectId } = projectRoute.useParams();
  return <ProjectConsole projectId={projectId} />;
}

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  component: ProjectDashboard,
  getParentRoute: () => rootRoute,
  path: "/",
});
const createProjectRoute = createRoute({
  component: CreateProjectPage,
  getParentRoute: () => rootRoute,
  path: "/projects/new",
});
const projectRoute = createRoute({
  component: ProjectPage,
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
});
const usageRoute = createRoute({
  component: UsagePage,
  getParentRoute: () => rootRoute,
  path: "/usage",
});
const mcpAuthorizationRoute = createRoute({
  component: McpAuthorization,
  getParentRoute: () => rootRoute,
  path: "/mcp/authorize",
});
const routeTree = rootRoute.addChildren([
  createRoute({
    component: McpConnections,
    getParentRoute: () => rootRoute,
    path: "/settings/connections",
  }),
  indexRoute,
  createProjectRoute,
  projectRoute,
  usageRoute,
  mcpAuthorizationRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
