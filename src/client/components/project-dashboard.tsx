import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Folder, Plus } from "lucide-react";

import type { ProjectResponse } from "../../shared/api";
import { browserApi } from "../api";
import { formatDateTime, sandboxStatusLabel, sandboxStatusTone } from "../presentation";
import { projectQueryKey } from "../query-keys";
import { AppHeaderSlot } from "./app-header-slot";
import { ErrorState, LoadingState } from "./ui-states";

export function ProjectDashboard() {
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
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : null}
        {projects.isSuccess && projects.data.length === 0 ? <ProjectEmptyState /> : null}
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
            <time dateTime={project.updatedAt}>{formatDateTime(project.updatedAt)}</time>
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
