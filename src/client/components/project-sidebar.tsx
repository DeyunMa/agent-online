import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChartNoAxesColumn,
  ChevronRight,
  Folder,
  LoaderCircle,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";

import { browserApi } from "../api";
import { projectQueryKey } from "../query-keys";

export function ProjectSidebar() {
  const [filter, setFilter] = useState("");
  const projects = useQuery({
    queryFn: browserApi.listProjects,
    queryKey: projectQueryKey,
  });
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleProjects =
    projects.data?.filter((project) =>
      project.title.toLocaleLowerCase().includes(normalizedFilter),
    ) ?? [];

  return (
    <aside className="project-sidebar">
      <div className="project-sidebar-heading">
        <h2>Projects</h2>
      </div>

      <label className="project-search">
        <Search aria-hidden="true" size={15} />
        <input
          aria-label="Filter projects"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter projects"
          type="search"
          value={filter}
        />
      </label>

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
          <p className="project-sidebar-state">
            {normalizedFilter ? "No matching projects" : "No projects yet"}
          </p>
        ) : null}
        {visibleProjects.length > 0 ? (
          <ul>
            {visibleProjects.map((project) => (
              <li key={project.id}>
                <Link
                  activeProps={{
                    className:
                      "project-sidebar-link project-sidebar-link-active",
                  }}
                  className="project-sidebar-link"
                  params={{ projectId: project.id }}
                  to="/projects/$projectId"
                >
                  <Folder aria-hidden="true" size={16} />
                  <span title={project.title}>{project.title}</span>
                  <ChevronRight aria-hidden="true" size={14} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="project-sidebar-footer">
        <Link
          activeProps={{
            className:
              "project-sidebar-usage project-sidebar-usage-active",
          }}
          className="project-sidebar-usage"
          to="/usage"
        >
          <ChartNoAxesColumn aria-hidden="true" size={16} />
          <span>Usage</span>
        </Link>
        <Link className="project-sidebar-new" to="/projects/new">
          <Plus aria-hidden="true" size={17} />
          <span>New project</span>
        </Link>
      </div>
    </aside>
  );
}
