import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Folder, LoaderCircle, Plus } from "lucide-react";

import { browserApi } from "../api";
import { projectQueryKey } from "../query-keys";
import { AccountMenu, type AccountMenuProps } from "./account-menu";
import { ProjectActionsMenu } from "./project-actions-menu";

export function ProjectSidebar({
  email,
  isSigningOut,
  name,
  onSignOut,
}: Omit<AccountMenuProps, "placement">) {
  const projects = useQuery({
    queryFn: browserApi.listProjects,
    queryKey: projectQueryKey,
  });
  const visibleProjects = projects.data ?? [];

  return (
    <aside className="project-sidebar">
      <div className="project-sidebar-heading">
        <h2>Projects</h2>
      </div>

      <Link className="project-sidebar-new" to="/projects/new">
        <Plus aria-hidden="true" size={17} />
        <span>New project</span>
      </Link>

      <div className="project-sidebar-section-label">All projects</div>
      <div className="project-sidebar-list">
        {projects.isPending ? (
          <div className="project-sidebar-state" role="status">
            <LoaderCircle aria-hidden="true" className="spin" size={15} />
            <span>Loading projects</span>
          </div>
        ) : null}
        {projects.isError ? (
          <button
            className="project-sidebar-retry"
            onClick={() => void projects.refetch()}
            type="button"
          >
            Could not load projects. Retry
          </button>
        ) : null}
        {projects.isSuccess && visibleProjects.length === 0 ? (
          <p className="project-sidebar-state">No projects yet</p>
        ) : null}
        {visibleProjects.length > 0 ? (
          <ul>
            {visibleProjects.map((project) => (
              <li key={project.id}>
                <div className="project-sidebar-item">
                  <Link
                    activeProps={{
                      className: "project-sidebar-link project-sidebar-link-active",
                    }}
                    className="project-sidebar-link"
                    params={{ projectId: project.id }}
                    to="/projects/$projectId"
                  >
                    <Folder aria-hidden="true" size={16} />
                    <span title={project.title}>{project.title}</span>
                  </Link>
                  <ProjectActionsMenu placement="sidebar" project={project} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="project-sidebar-footer">
        <AccountMenu
          email={email}
          isSigningOut={isSigningOut}
          name={name}
          onSignOut={onSignOut}
          placement="sidebar"
        />
      </div>
    </aside>
  );
}
