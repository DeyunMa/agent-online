import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRoute, createRoute, createRouter, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleDashed,
  FolderKanban,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  Plus,
  Square,
  TerminalSquare,
  UserRound,
  XCircle,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { isTerminalAgentRun, type AgentRunStatus } from "../domain/agent-run";
import type { AgentRunResponse, MessageResponse, ProjectResponse, SandboxLeaseResponse } from "../shared/api";
import { BrowserApiError, browserApi, subscribeToAgentRun } from "./api";
import { authClient } from "./auth";

const projectQueryKey = ["projects"] as const;

function activeAgentRunQueryKey(projectId: string) {
  return ["active-agent-run", projectId] as const;
}

function AppShell() {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

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
      setSignOutError("退出登录失败，请稍后重试。");
    } finally {
      setIsSigningOut(false);
    }
  }

  if (session.isPending) {
    return <AuthLoadingScreen />;
  }

  if (!session.data) {
    return <AuthGate sessionError={session.error ? authErrorMessage(session.error) : null} onAuthenticated={session.refetch} />;
  }

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
        </nav>

        <div className="sidebar-account">
          <div className="account-identity">
            <UserRound aria-hidden="true" size={16} />
            <span title={session.data.user.email}>{session.data.user.name || session.data.user.email}</span>
          </div>
          <button className="sidebar-sign-out" disabled={isSigningOut} onClick={() => void signOut()} type="button">
            {isSigningOut ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <LogOut aria-hidden="true" size={15} />}
            <span>{isSigningOut ? "正在退出" : "退出登录"}</span>
          </button>
          {signOutError ? <p className="sidebar-auth-error" role="alert">{signOutError}</p> : null}
        </div>
        <div className="sidebar-footer">开发基线</div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
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
        <span>正在确认登录状态</span>
      </div>
    </main>
  );
}

function AuthGate({ onAuthenticated, sessionError }: { onAuthenticated: () => Promise<void>; sessionError: string | null }) {
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
      setFormError("请输入邮箱地址。");
      return;
    }

    if (mode === "sign-up" && !normalizedName) {
      setFormError("请输入显示名称。");
      return;
    }

    if (password.length < 8) {
      setFormError("密码至少需要 8 个字符。");
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email: normalizedEmail, password })
          : await authClient.signUp.email({ email: normalizedEmail, name: normalizedName, password });

      if (result.error) {
        setFormError(authErrorMessage(result.error));
        return;
      }

      await onAuthenticated();
    } catch {
      setFormError("认证服务暂时不可用，请稍后重试。");
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
          <p className="eyebrow">PERSONAL CODING AGENT</p>
          <h1 id="auth-title">{mode === "sign-in" ? "登录" : "创建账号"}</h1>
          <p>使用邮箱密码进入你的项目。</p>
        </div>

        <div aria-label="认证方式" className="auth-mode" role="tablist">
          <button
            aria-controls="auth-form"
            aria-selected={mode === "sign-in"}
            className={mode === "sign-in" ? "auth-mode-option auth-mode-option-active" : "auth-mode-option"}
            id="auth-sign-in-tab"
            onClick={() => changeMode("sign-in")}
            role="tab"
            type="button"
          >
            登录
          </button>
          <button
            aria-controls="auth-form"
            aria-selected={mode === "sign-up"}
            className={mode === "sign-up" ? "auth-mode-option auth-mode-option-active" : "auth-mode-option"}
            id="auth-sign-up-tab"
            onClick={() => changeMode("sign-up")}
            role="tab"
            type="button"
          >
            注册
          </button>
        </div>

        {sessionError ? <p className="auth-session-note" role="status">{sessionError}</p> : null}

        <form
          aria-labelledby={mode === "sign-in" ? "auth-sign-in-tab" : "auth-sign-up-tab"}
          className="auth-form"
          id="auth-form"
          onSubmit={(event) => void submit(event)}
          role="tabpanel"
        >
          {mode === "sign-up" ? (
            <div className="form-field">
              <label htmlFor="auth-name">显示名称</label>
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
            <label htmlFor="auth-email">邮箱</label>
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
            <label htmlFor="auth-password">密码</label>
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              disabled={isSubmitting}
              id="auth-password"
              minLength={8}
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </div>
          {formError ? <p className="auth-error" role="alert">{formError}</p> : null}
          <button className="primary-action auth-submit" disabled={isSubmitting} type="submit">
            {isSubmitting ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : null}
            <span>{isSubmitting ? "正在处理" : mode === "sign-in" ? "登录" : "创建账号"}</span>
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard() {
  const projects = useQuery({ queryFn: browserApi.listProjects, queryKey: projectQueryKey });
  const health = useQuery({ queryFn: browserApi.getHealth, queryKey: ["health"] });

  return (
    <>
      <PageHeader
        action={
          <Link className="primary-action" to="/projects/new">
            <Plus aria-hidden="true" size={17} />
            <span>新建项目</span>
          </Link>
        }
        eyebrow="AGENT ONLINE"
        title="项目"
      />

      <section className="dashboard-grid">
        <div className="workspace-list" aria-label="项目列表">
          <div className="section-heading">
            <div>
              <p className="section-kicker">WORKSPACE</p>
              <h2>你的项目</h2>
            </div>
            <span className="count" aria-label={`${projects.data?.length ?? 0} 个项目`}>
              {projects.data?.length ?? 0}
            </span>
          </div>

          {projects.isPending ? <LoadingState label="正在读取项目" /> : null}
          {projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} /> : null}
          {projects.isSuccess && projects.data.length === 0 ? <ProjectEmptyState /> : null}
          {projects.isSuccess && projects.data.length > 0 ? <ProjectList projects={projects.data} /> : null}
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
              <dt>工作区</dt>
              <dd>仅在存活沙箱中保留</dd>
            </div>
          </dl>
        </aside>
      </section>
    </>
  );
}

function ProjectList({ projects }: { projects: ProjectResponse[] }) {
  return (
    <ul className="project-list">
      {projects.map((project) => (
        <li key={project.id}>
          <Link className="project-row" params={{ projectId: project.id }} to="/projects/$projectId">
            <div className="project-row-icon" aria-hidden="true">
              <FolderKanban size={18} />
            </div>
            <div className="project-row-content">
              <strong>{project.title}</strong>
              <span>
                {project.sandboxLease ? `沙箱：${sandboxStatusLabel(project.sandboxLease.status)}` : "尚未启动沙箱"}
              </span>
            </div>
            <time dateTime={project.updatedAt}>{formatDate(project.updatedAt)}</time>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ProjectEmptyState() {
  return (
    <div className="empty-state">
      <FolderKanban aria-hidden="true" size={28} strokeWidth={1.5} />
      <div>
        <p>还没有项目。</p>
        <span>创建一个项目后，即可在临时沙箱中开始任务。</span>
      </div>
      <Link className="secondary-action" to="/projects/new">
        <Plus aria-hidden="true" size={16} />
        <span>新建项目</span>
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
      await navigate({ params: { projectId: project.id }, to: "/projects/$projectId" });
    },
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();

    if (!normalizedTitle) {
      setValidationError("请输入项目名称。");
      return;
    }

    setValidationError(null);
    try {
      await createProject.mutateAsync({ title: normalizedTitle });
    } catch {
      // React Query exposes the failure next to the form.
    }
  }

  return (
    <section className="form-page">
      <Link className="back-link" to="/">
        <ArrowLeft aria-hidden="true" size={16} />
        <span>返回项目</span>
      </Link>
      <div className="form-heading">
        <p className="eyebrow">NEW PROJECT</p>
        <h1>新建项目</h1>
        <p>项目会保存对话和执行记录。工作区文件只在当前沙箱存活期间保留。</p>
      </div>

      <form className="project-form" onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="project-title">项目名称</label>
        <input
          autoComplete="off"
          autoFocus
          disabled={createProject.isPending}
          id="project-title"
          maxLength={120}
          name="title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：个人网站"
          value={title}
        />
        {validationError ? <p className="field-error">{validationError}</p> : null}
        {createProject.isError ? <ErrorState compact error={createProject.error} /> : null}
        <div className="form-actions">
          <Link className="secondary-action" to="/">
            取消
          </Link>
          <button className="primary-action" disabled={createProject.isPending} type="submit">
            {createProject.isPending ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <Plus aria-hidden="true" size={16} />}
            <span>{createProject.isPending ? "正在创建" : "创建项目"}</span>
          </button>
        </div>
      </form>
    </section>
  );
}

function ProjectDetail() {
  const { projectId } = projectRoute.useParams();
  const queryClient = useQueryClient();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [streamOutput, setStreamOutput] = useState("");
  const [streamError, setStreamError] = useState<BrowserApiError | null>(null);
  const project = useQuery({
    queryFn: () => browserApi.getProject(projectId),
    queryKey: ["project", projectId],
  });
  const messages = useQuery({
    enabled: project.isSuccess,
    queryFn: () => browserApi.listMessages(projectId),
    queryKey: ["project-messages", projectId],
  });
  const activeAgentRun = useQuery({
    enabled: project.isSuccess,
    queryFn: () => browserApi.getActiveAgentRun(projectId),
    queryKey: activeAgentRunQueryKey(projectId),
  });
  const agentRun = useQuery({
    enabled: activeRunId !== null,
    queryFn: () => browserApi.getAgentRun(projectId, activeRunId ?? ""),
    queryKey: ["agent-run", projectId, activeRunId],
    refetchInterval: (query) => (query.state.data && isTerminalAgentRun(query.state.data.status) ? false : 2_000),
  });
  const createRun = useMutation({
    mutationFn: (content: string) => browserApi.createAgentRun(projectId, { content }),
    onSuccess: async (run) => {
      setActiveRunId(run.id);
      setStreamOutput("");
      setStreamError(null);
      queryClient.setQueryData(["agent-run", projectId, run.id], run);
      queryClient.setQueryData(activeAgentRunQueryKey(projectId), run);
      await queryClient.invalidateQueries({ queryKey: ["project-messages", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
  const cancelRun = useMutation({
    mutationFn: (runId: string) => browserApi.cancelAgentRun(projectId, runId),
    onSuccess: (run) => {
      queryClient.setQueryData(["agent-run", projectId, run.id], run);
    },
  });
  const currentRun = agentRun.data;
  const currentRunId = currentRun?.id ?? null;
  const recoveredActiveRun = activeAgentRun.data;
  const activeRunIsBlocking =
    activeAgentRun.isPending ||
    (recoveredActiveRun !== null && recoveredActiveRun !== undefined && !isTerminalAgentRun(recoveredActiveRun.status)) ||
    (activeRunId !== null && (currentRun === undefined || !isTerminalAgentRun(currentRun.status)));

  useEffect(() => {
    setActiveRunId(null);
    setStreamOutput("");
    setStreamError(null);
  }, [projectId]);

  useEffect(() => {
    const recoveredRun = recoveredActiveRun;

    if (!recoveredRun || isTerminalAgentRun(recoveredRun.status)) {
      return;
    }

    queryClient.setQueryData(["agent-run", projectId, recoveredRun.id], recoveredRun);
    setActiveRunId((currentRunId) => currentRunId ?? recoveredRun.id);
  }, [projectId, queryClient, recoveredActiveRun]);

  useEffect(() => {
    if (!currentRun || !isTerminalAgentRun(currentRun.status)) {
      return;
    }

    setStreamError(null);
    void queryClient.invalidateQueries({ queryKey: activeAgentRunQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
  }, [currentRun?.id, currentRun?.status, projectId, queryClient]);

  useEffect(() => {
    if (!currentRunId) {
      return;
    }

    return subscribeToAgentRun(projectId, currentRunId, {
      onError: setStreamError,
      onEvent: (event) => {
        if (event.type === "agent.output") {
          setStreamOutput((output) => `${output}${event.chunk}`);
          return;
        }

        if (event.type === "run.status") {
          queryClient.setQueryData<AgentRunResponse>(["agent-run", projectId, currentRunId], (run) =>
            run ? { ...run, status: event.status } : run,
          );

          if (isTerminalAgentRun(event.status)) {
            setStreamError(null);
            void queryClient.invalidateQueries({ queryKey: activeAgentRunQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
          }

          return;
        }

        if (event.type === "run.completed") {
          queryClient.setQueryData<AgentRunResponse>(["agent-run", projectId, currentRunId], (run) =>
            run ? { ...run, usage: event.usage } : run,
          );
          setStreamOutput("");
          setStreamError(null);
          void queryClient.invalidateQueries({ queryKey: ["agent-run", projectId, currentRunId] });
          void queryClient.invalidateQueries({ queryKey: activeAgentRunQueryKey(projectId) });
          void queryClient.invalidateQueries({ queryKey: ["project-messages", projectId] });
          void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        }
      },
    });
  }, [currentRunId, projectId, queryClient]);

  if (project.isPending) {
    return <LoadingState label="正在读取项目" />;
  }

  if (project.isError) {
    return (
      <section className="detail-page">
        <Link className="back-link" to="/">
          <ArrowLeft aria-hidden="true" size={16} />
          <span>返回项目</span>
        </Link>
        <ErrorState error={project.error} onRetry={() => void project.refetch()} />
      </section>
    );
  }

  return (
    <section className="detail-page">
      <div className="detail-topline">
        <Link className="back-link" to="/">
          <ArrowLeft aria-hidden="true" size={16} />
          <span>项目</span>
        </Link>
        <SandboxLeaseBadge project={project.data} />
      </div>

      <PageHeader eyebrow="PROJECT" title={project.data.title} />

      <div className="project-layout">
        <div className="conversation-surface">
          <Conversation messages={messages.data} query={messages} streamOutput={streamOutput} />
          <RunStatus
            cancelError={cancelRun.error}
            isCancelling={cancelRun.isPending}
            loadError={activeAgentRun.error ?? agentRun.error}
            onCancel={() => {
              if (currentRun) {
                cancelRun.mutate(currentRun.id);
              }
            }}
            run={currentRun}
            streamError={streamError}
          />
          <RunComposer
            disabled={createRun.isPending || activeRunIsBlocking}
            error={createRun.error}
            isSubmitting={createRun.isPending}
            onSubmit={(content) => createRun.mutateAsync(content)}
          />
        </div>

        <aside className="project-aside">
          <p className="section-kicker">WORKSPACE</p>
          <h2>临时工作区</h2>
          <p>代码和依赖只在当前沙箱中保留。沙箱停止、过期或故障后，文件可能丢失。</p>
          <dl className="project-meta">
            <div>
              <dt>默认 Agent</dt>
              <dd>{project.data.defaultAgentRuntimeId}</dd>
            </div>
            <div>
              <dt>沙箱状态</dt>
              <dd>{project.data.sandboxLease ? sandboxStatusLabel(project.data.sandboxLease.status) : "尚未启动"}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  );
}

function Conversation({
  messages,
  query,
  streamOutput,
}: {
  messages: MessageResponse[] | undefined;
  query: ReturnType<typeof useQuery<MessageResponse[], Error>>;
  streamOutput: string;
}) {
  if (query.isPending) {
    return <LoadingState label="正在读取对话" />;
  }

  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const visibleMessages = messages ?? [];

  return (
    <div className="conversation" aria-label="项目对话">
      <div className="conversation-heading">
        <div>
          <p className="section-kicker">CONVERSATION</p>
          <h2>执行对话</h2>
        </div>
        <MessageSquareText aria-hidden="true" size={19} />
      </div>
      {visibleMessages.length === 0 && !streamOutput ? (
        <div className="conversation-empty">
          <Bot aria-hidden="true" size={24} strokeWidth={1.5} />
          <p>描述一个任务，Pi 会在沙箱中执行。</p>
        </div>
      ) : (
        <ol className="message-list">
          {visibleMessages.map((message) => (
            <li className={`message message-${message.role}`} key={message.id}>
              <span className="message-role">{message.role === "user" ? "你" : "Pi"}</span>
              <div>
                <p>{message.content}</p>
                <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
              </div>
            </li>
          ))}
          {streamOutput ? (
            <li className="message message-assistant message-streaming" aria-live="polite">
              <span className="message-role">Pi</span>
              <div>
                <p>{streamOutput}</p>
                <span className="streaming-label">正在生成</span>
              </div>
            </li>
          ) : null}
        </ol>
      )}
    </div>
  );
}

function RunComposer({
  disabled,
  error,
  isSubmitting,
  onSubmit,
}: {
  disabled: boolean;
  error: Error | null;
  isSubmitting: boolean;
  onSubmit: (content: string) => Promise<unknown>;
}) {
  const [content, setContent] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();

    if (!trimmed) {
      setValidationError("请输入要执行的任务。");
      return;
    }

    setValidationError(null);
    void submitRun(trimmed);
  }

  async function submitRun(contentToSubmit: string) {
    try {
      await onSubmit(contentToSubmit);
      setContent("");
    } catch {
      // React Query exposes the failure next to the composer.
    }
  }

  return (
    <form className="run-composer" onSubmit={submit}>
      <label htmlFor="agent-task">交给 Pi 的任务</label>
      <textarea
        disabled={disabled}
        id="agent-task"
        name="content"
        onChange={(event) => setContent(event.target.value)}
        placeholder="例如：检查当前项目结构，并告诉我下一步应该做什么。"
        rows={4}
        value={content}
      />
      {validationError ? <p className="field-error">{validationError}</p> : null}
      {error ? <ErrorState compact error={error} /> : null}
      <div className="composer-footer">
        <span>一次执行会启动一个短生命周期 Agent 进程。</span>
        <button className="primary-action" disabled={disabled} type="submit">
          {isSubmitting ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <Activity aria-hidden="true" size={16} />}
          <span>{isSubmitting ? "正在提交" : "开始执行"}</span>
        </button>
      </div>
    </form>
  );
}

function RunStatus({
  cancelError,
  isCancelling,
  loadError,
  onCancel,
  run,
  streamError,
}: {
  cancelError: Error | null;
  isCancelling: boolean;
  loadError: Error | null;
  onCancel: () => void;
  run: AgentRunResponse | undefined;
  streamError: BrowserApiError | null;
}) {
  if (loadError) {
    return <ErrorState compact error={loadError} />;
  }

  if (!run) {
    return null;
  }

  const terminal = isTerminalAgentRun(run.status);

  return (
    <section className="run-status" aria-live="polite">
      <div className="run-status-main">
        <RunStatusIcon status={run.status} />
        <div>
          <p className="section-kicker">AGENT RUN</p>
          <strong>{agentRunStatusLabel(run.status)}</strong>
          <span>{run.modelId}</span>
        </div>
      </div>
      <div className="run-status-actions">
        {run.failureReason ? <p className="run-failure">{run.failureReason}</p> : null}
        {streamError ? <p className="run-stream-note">{streamError.message}</p> : null}
        {cancelError ? <ErrorState compact error={cancelError} /> : null}
        {!terminal ? (
          <button className="danger-action" disabled={isCancelling} onClick={onCancel} type="button">
            {isCancelling ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <Square aria-hidden="true" size={15} />}
            <span>{isCancelling ? "正在取消" : "取消执行"}</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

function RunStatusIcon({ status }: { status: AgentRunStatus }) {
  if (status === "succeeded") {
    return <CheckCircle2 aria-hidden="true" className="status-icon status-icon-success" size={20} />;
  }

  if (status === "failed" || status === "cancelled" || status === "timed_out" || status === "interrupted") {
    return <XCircle aria-hidden="true" className="status-icon status-icon-error" size={20} />;
  }

  return <CircleDashed aria-hidden="true" className="status-icon status-icon-pending spin" size={20} />;
}

function SandboxLeaseBadge({ project }: { project: ProjectResponse }) {
  const status = project.sandboxLease?.status;

  return <span className="lease-badge">{status ? `沙箱：${sandboxStatusLabel(status)}` : "尚未启动沙箱"}</span>;
}

function PageHeader({ action, eyebrow, title }: { action?: ReactNode; eyebrow: string; title: string }) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {action}
    </header>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle aria-hidden="true" className="spin" size={20} />
      <span>{label}</span>
    </div>
  );
}

function ErrorState({ compact = false, error, onRetry }: { compact?: boolean; error: Error; onRetry?: () => void }) {
  const requestId = error instanceof BrowserApiError ? error.requestId : null;

  return (
    <div className={compact ? "error-state error-state-compact" : "error-state"} role="alert">
      <AlertCircle aria-hidden="true" size={compact ? 16 : 20} />
      <div>
        <p>{error.message}</p>
        {requestId ? <span>请求 ID：{requestId}</span> : null}
      </div>
      {onRetry ? (
        <button className="text-action" onClick={onRetry} type="button">
          重试
        </button>
      ) : null}
    </div>
  );
}

function authErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    if (error.code === "USER_ALREADY_EXISTS") {
      return "该邮箱已注册，请直接登录。";
    }

    if (error.code === "INVALID_EMAIL_OR_PASSWORD") {
      return "邮箱或密码不正确。";
    }
  }

  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    if (error.message === "Invalid email or password") {
      return "邮箱或密码不正确。";
    }

    if (error.message === "User already exists") {
      return "该邮箱已注册，请直接登录。";
    }
  }

  return "认证请求未完成，请检查填写的信息后重试。";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function sandboxStatusLabel(status: SandboxLeaseResponse["status"]) {
  const labels: Record<string, string> = {
    busy: "执行中",
    failed: "异常",
    idle: "空闲",
    ready: "就绪",
    starting: "启动中",
    stopped: "已停止",
  };

  return labels[status] ?? status;
}

function agentRunStatusLabel(status: AgentRunStatus) {
  const labels: Record<AgentRunStatus, string> = {
    cancelled: "已取消",
    cancelling: "正在取消",
    failed: "执行失败",
    interrupted: "执行中断",
    queued: "等待执行",
    running: "正在执行",
    starting: "正在启动",
    succeeded: "执行完成",
    timed_out: "执行超时",
  };

  return labels[status];
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
  component: ProjectDetail,
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
});
const routeTree = rootRoute.addChildren([indexRoute, createProjectRoute, projectRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
