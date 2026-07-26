import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  LoaderCircle,
  Plus,
  TerminalSquare,
} from "lucide-react";
import { type FormEvent, useState } from "react";

import type { ProjectResponse } from "../shared/api";
import { browserApi } from "./api";
import { authClient } from "./auth";
import { AppHeader } from "./components/app-header";
import {
  AppHeaderSlot,
  AppHeaderSlotProvider,
} from "./components/app-header-slot";
import { ProjectConsole } from "./components/project-console";
import { ProjectSidebar } from "./components/project-sidebar";
import { UsagePage } from "./components/usage-page";
import { ErrorState, LoadingState } from "./components/ui-states";
import {
  formatDateTime,
  sandboxStatusLabel,
  sandboxStatusTone,
} from "./presentation";
import { projectQueryKey } from "./query-keys";

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
        sessionError={
          session.error ? authErrorMessage(session.error) : null
        }
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
      <ProjectSidebar />
      <div className="main-content">
        {signOutError ? (
          <p className="global-notice" role="alert">
            {signOutError}
          </p>
        ) : null}
        <AppHeaderSlotProvider target={headerSlot}>
          <Outlet />
        </AppHeaderSlotProvider>
      </div>
    </div>
  );
}

type AuthMode = "sign-in" | "sign-up";

function AuthLoadingScreen() {
  return (
    <main className="auth-shell">
      <div className="auth-loading" role="status">
        <TerminalSquare aria-hidden="true" size={22} />
        <LoaderCircle aria-hidden="true" className="spin" size={18} />
        <span>Checking your session</span>
      </div>
    </main>
  );
}

function AuthGate({
  onAuthenticated,
  sessionError,
}: {
  onAuthenticated: () => Promise<void>;
  sessionError: string | null;
}) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    const normalizedName = name.trim();

    if (!normalizedEmail) {
      setFormError("Enter your email address.");
      return;
    }
    if (mode === "sign-up" && !normalizedName) {
      setFormError("Enter a display name.");
      return;
    }
    if (password.length < 8) {
      setFormError("Password must contain at least 8 characters.");
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({
              email: normalizedEmail,
              password,
            })
          : await authClient.signUp.email({
              email: normalizedEmail,
              name: normalizedName,
              password,
            });

      if (result.error) {
        setFormError(authErrorMessage(result.error));
        return;
      }

      await onAuthenticated();
    } catch {
      setFormError("Authentication is temporarily unavailable.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setFormError(null);
  }

  return (
    <main className="auth-shell">
      <section aria-labelledby="auth-title" className="auth-panel">
        <div className="auth-brand">
          <TerminalSquare aria-hidden="true" size={21} />
          <span>Agent Online</span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">HOSTED CODING AGENT</p>
          <h1 id="auth-title">
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </h1>
          <p>Use email and password to access your projects.</p>
        </div>

        <div aria-label="Authentication mode" className="auth-mode" role="tablist">
          <button
            aria-controls="auth-form"
            aria-selected={mode === "sign-in"}
            className={
              mode === "sign-in"
                ? "auth-mode-option auth-mode-option-active"
                : "auth-mode-option"
            }
            id="auth-sign-in-tab"
            onClick={() => changeMode("sign-in")}
            role="tab"
            type="button"
          >
            Sign in
          </button>
          <button
            aria-controls="auth-form"
            aria-selected={mode === "sign-up"}
            className={
              mode === "sign-up"
                ? "auth-mode-option auth-mode-option-active"
                : "auth-mode-option"
            }
            id="auth-sign-up-tab"
            onClick={() => changeMode("sign-up")}
            role="tab"
            type="button"
          >
            Register
          </button>
        </div>

        {sessionError ? (
          <p className="auth-session-note" role="status">
            {sessionError}
          </p>
        ) : null}

        <form
          aria-labelledby={
            mode === "sign-in"
              ? "auth-sign-in-tab"
              : "auth-sign-up-tab"
          }
          className="auth-form"
          id="auth-form"
          onSubmit={(event) => void submit(event)}
          role="tabpanel"
        >
          {mode === "sign-up" ? (
            <div className="form-field">
              <label htmlFor="auth-name">Display name</label>
              <input
                autoComplete="name"
                disabled={isSubmitting}
                id="auth-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
          ) : null}
          <div className="form-field">
            <label htmlFor="auth-email">Email</label>
            <input
              autoComplete="email"
              disabled={isSubmitting}
              id="auth-email"
              inputMode="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              type="email"
              value={email}
            />
          </div>
          <div className="form-field">
            <label htmlFor="auth-password">Password</label>
            <input
              autoComplete={
                mode === "sign-in" ? "current-password" : "new-password"
              }
              disabled={isSubmitting}
              id="auth-password"
              minLength={8}
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </div>
          {formError ? (
            <p className="auth-error" role="alert">
              {formError}
            </p>
          ) : null}
          <button
            className="primary-action auth-submit"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? (
              <LoaderCircle aria-hidden="true" className="spin" size={16} />
            ) : null}
            <span>
              {isSubmitting
                ? "Working"
                : mode === "sign-in"
                  ? "Sign in"
                  : "Create account"}
            </span>
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard() {
  const projects = useQuery({
    queryFn: browserApi.listProjects,
    queryKey: projectQueryKey,
  });

  return (
    <section className="project-index">
      <AppHeaderSlot>
        <div className="app-header-page">
          <strong>Projects</strong>
        </div>
      </AppHeaderSlot>
      <header className="page-command-bar">
        <div>
          <p className="eyebrow">AGENT ONLINE</p>
          <h1>Projects</h1>
        </div>
        <Link className="primary-action" to="/projects/new">
          <Plus aria-hidden="true" size={16} />
          <span>New project</span>
        </Link>
      </header>

      <div className="project-index-list">
        {projects.isPending ? <LoadingState label="Loading projects" /> : null}
        {projects.isError ? (
          <ErrorState
            error={projects.error}
            onRetry={() => void projects.refetch()}
          />
        ) : null}
        {projects.isSuccess && projects.data.length === 0 ? (
          <ProjectEmptyState />
        ) : null}
        {projects.isSuccess && projects.data.length > 0 ? (
          <ProjectList projects={projects.data} />
        ) : null}
      </div>
    </section>
  );
}

function ProjectList({ projects }: { projects: ProjectResponse[] }) {
  return (
    <ul className="project-list">
      {projects.map((project) => (
        <li key={project.id}>
          <Link
            className="project-row"
            params={{ projectId: project.id }}
            to="/projects/$projectId"
          >
            <span className="project-row-icon">
              <Folder aria-hidden="true" size={17} />
            </span>
            <span className="project-row-copy">
              <strong>{project.title}</strong>
              <span>
                {project.sandboxLease
                  ? sandboxStatusLabel(project.sandboxLease.status)
                  : "Sandbox not started"}
              </span>
            </span>
            <span
              className={`project-row-status ${sandboxStatusTone(project.sandboxLease?.status)}`}
            >
              <span aria-hidden="true" />
              {project.sandboxLease
                ? sandboxStatusLabel(project.sandboxLease.status)
                : "No sandbox"}
            </span>
            <time dateTime={project.updatedAt}>
              {formatDateTime(project.updatedAt)}
            </time>
            <ChevronRight aria-hidden="true" size={15} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ProjectEmptyState() {
  return (
    <div className="empty-state">
      <Folder aria-hidden="true" size={26} strokeWidth={1.5} />
      <p>No projects yet.</p>
      <Link className="secondary-action" to="/projects/new">
        <Plus aria-hidden="true" size={16} />
        <span>New project</span>
      </Link>
    </div>
  );
}

function CreateProjectPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const createProject = useMutation({
    mutationFn: browserApi.createProject,
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: projectQueryKey });
      await navigate({
        params: { projectId: project.id },
        to: "/projects/$projectId",
      });
    },
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setValidationError("Enter a project name.");
      return;
    }

    setValidationError(null);
    try {
      await createProject.mutateAsync({ title: normalizedTitle });
    } catch {
      // React Query exposes the request failure next to the form.
    }
  }

  return (
    <section className="create-project-page">
      <AppHeaderSlot>
        <nav aria-label="Breadcrumb" className="app-header-breadcrumb">
          <Link to="/">Projects</Link>
          <ChevronRight aria-hidden="true" size={14} />
          <strong>New project</strong>
        </nav>
      </AppHeaderSlot>
      <Link className="back-link" to="/">
        <ArrowLeft aria-hidden="true" size={16} />
        <span>Projects</span>
      </Link>
      <header>
        <p className="eyebrow">NEW PROJECT</p>
        <h1>Create project</h1>
      </header>
      <form className="project-form" onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="project-title">Project name</label>
        <input
          autoComplete="off"
          autoFocus
          disabled={createProject.isPending}
          id="project-title"
          maxLength={120}
          name="title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="acme-dashboard"
          value={title}
        />
        {validationError ? (
          <p className="field-error">{validationError}</p>
        ) : null}
        {createProject.isError ? (
          <ErrorState compact error={createProject.error} />
        ) : null}
        <div className="form-actions">
          <Link className="secondary-action" to="/">
            Cancel
          </Link>
          <button
            className="primary-action"
            disabled={createProject.isPending}
            type="submit"
          >
            {createProject.isPending ? (
              <LoaderCircle aria-hidden="true" className="spin" size={16} />
            ) : (
              <Plus aria-hidden="true" size={16} />
            )}
            <span>
              {createProject.isPending ? "Creating" : "Create project"}
            </span>
          </button>
        </div>
      </form>
    </section>
  );
}

function ProjectPage() {
  const { projectId } = projectRoute.useParams();
  return <ProjectConsole projectId={projectId} />;
}

function authErrorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === "This deployment is invite-only."
  ) {
    return "This deployment is invite-only.";
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (error.code === "USER_ALREADY_EXISTS") {
      return "This email is already registered.";
    }
    if (error.code === "INVALID_EMAIL_OR_PASSWORD") {
      return "Email or password is incorrect.";
    }
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    if (error.message === "Invalid email or password") {
      return "Email or password is incorrect.";
    }
    if (error.message === "User already exists") {
      return "This email is already registered.";
    }
  }

  return "Authentication request could not be completed.";
}

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  component: Dashboard,
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
const routeTree = rootRoute.addChildren([
  indexRoute,
  createProjectRoute,
  projectRoute,
  usageRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
