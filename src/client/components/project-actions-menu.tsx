import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { ProjectResponse } from "../../shared/api";
import { browserApi } from "../api";
import { projectDetailQueryKey, projectQueryKey, userUsageQueryKey } from "../query-keys";
import { ErrorState } from "./ui-states";

type ProjectActionsPlacement = "header" | "row" | "sidebar";

export function ProjectActionsMenu({
  placement,
  project,
}: {
  placement: ProjectActionsPlacement;
  project: ProjectResponse;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<"delete" | "rename" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const [title, setTitle] = useState(project.title);

  const renameProject = useMutation({
    mutationFn: (nextTitle: string) => browserApi.updateProject(project.id, { title: nextTitle }),
    onSuccess: async (updatedProject) => {
      queryClient.setQueryData<ProjectResponse[]>(projectQueryKey, (projects) =>
        projects?.map((item) => (item.id === updatedProject.id ? updatedProject : item)),
      );
      queryClient.setQueryData(projectDetailQueryKey(updatedProject.id), updatedProject);
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: userUsageQueryKey });
    },
  });
  const deleteProject = useMutation({
    mutationFn: () => browserApi.deleteProject(project.id),
    onSuccess: async () => {
      setDialog(null);
      queryClient.setQueryData<ProjectResponse[]>(projectQueryKey, (projects) =>
        projects?.filter((item) => item.id !== project.id),
      );
      queryClient.removeQueries({
        predicate: ({ queryKey }) => queryKey[1] === project.id,
      });
      if (isProjectOpen(project.id)) {
        await navigate({ to: "/" });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectQueryKey }),
        queryClient.invalidateQueries({ queryKey: userUsageQueryKey }),
      ]);
    },
  });

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const closeOnViewportChange = () => setMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!dialog) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      if (dialog === "rename") {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      } else {
        deleteButtonRef.current?.focus();
      }
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !renameProject.isPending && !deleteProject.isPending) {
        setDialog(null);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [deleteProject.isPending, dialog, renameProject.isPending]);

  const normalizedTitle = title.trim();
  const renameDisabled =
    renameProject.isPending || normalizedTitle.length === 0 || normalizedTitle === project.title;

  function toggleMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 176;
    const menuHeight = 88;
    setMenuPosition({
      left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8)),
    });
    setMenuOpen(true);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (renameDisabled) {
      return;
    }

    try {
      await renameProject.mutateAsync(normalizedTitle);
    } catch {
      // React Query exposes the request failure in the dialog.
    }
  }

  function closeDialog() {
    if (renameProject.isPending || deleteProject.isPending) {
      return;
    }
    setDialog(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div
      className={`project-actions project-actions-${placement}`}
      data-placement={placement}
      ref={rootRef}
    >
      <button
        aria-controls={menuOpen ? menuId : undefined}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={`Project actions for ${project.title}`}
        className="project-actions-trigger"
        onClick={toggleMenu}
        ref={triggerRef}
        title="Project actions"
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={17} />
      </button>

      {menuOpen
        ? createPortal(
            <div
              aria-label={`Project actions for ${project.title}`}
              className="project-actions-menu"
              id={menuId}
              ref={menuRef}
              role="menu"
              style={menuPosition}
            >
              <button
                onClick={() => {
                  setTitle(project.title);
                  renameProject.reset();
                  setMenuOpen(false);
                  setDialog("rename");
                }}
                role="menuitem"
                type="button"
              >
                <Pencil aria-hidden="true" size={15} />
                <span>Rename</span>
              </button>
              <button
                className="project-actions-delete"
                onClick={() => {
                  deleteProject.reset();
                  setMenuOpen(false);
                  setDialog("delete");
                }}
                role="menuitem"
                type="button"
              >
                <Trash2 aria-hidden="true" size={15} />
                <span>Delete</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {dialog === "rename"
        ? createPortal(
            <div
              className="project-dialog-backdrop"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeDialog();
                }
              }}
            >
              <section
                aria-labelledby={`${menuId}-rename-title`}
                aria-modal="true"
                className="project-dialog"
                role="dialog"
              >
                <header>
                  <h2 id={`${menuId}-rename-title`}>Rename project</h2>
                  <p>Update the name shown in Projects, Usage, and the project console.</p>
                </header>
                <form onSubmit={(event) => void submitRename(event)}>
                  <label htmlFor={`${menuId}-project-title`}>Project name</label>
                  <input
                    autoComplete="off"
                    disabled={renameProject.isPending}
                    id={`${menuId}-project-title`}
                    maxLength={120}
                    onChange={(event) => setTitle(event.target.value)}
                    ref={renameInputRef}
                    value={title}
                  />
                  {normalizedTitle.length === 0 ? (
                    <p className="field-error">Enter a project name.</p>
                  ) : null}
                  {renameProject.isError ? (
                    <ErrorState compact error={renameProject.error} />
                  ) : null}
                  <div className="project-dialog-actions">
                    <button
                      className="secondary-action"
                      disabled={renameProject.isPending}
                      onClick={closeDialog}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button className="primary-action" disabled={renameDisabled} type="submit">
                      {renameProject.isPending ? (
                        <LoaderCircle aria-hidden="true" className="spin" size={15} />
                      ) : null}
                      <span>{renameProject.isPending ? "Saving" : "Save"}</span>
                    </button>
                  </div>
                </form>
              </section>
            </div>,
            document.body,
          )
        : null}

      {dialog === "delete"
        ? createPortal(
            <div
              className="project-dialog-backdrop"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeDialog();
                }
              }}
            >
              <section
                aria-labelledby={`${menuId}-delete-title`}
                aria-modal="true"
                className="project-dialog"
                role="dialog"
              >
                <header>
                  <h2 id={`${menuId}-delete-title`}>Delete project</h2>
                  <p>
                    Delete <strong>{project.title}</strong>? Messages, Agent Runs, usage recorded by
                    those Runs, and current sandbox files will be permanently removed. This cannot
                    be undone.
                  </p>
                </header>
                {deleteProject.isError ? <ErrorState compact error={deleteProject.error} /> : null}
                <div className="project-dialog-actions">
                  <button
                    className="secondary-action"
                    disabled={deleteProject.isPending}
                    onClick={closeDialog}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="danger-action"
                    disabled={deleteProject.isPending}
                    onClick={() => deleteProject.mutate()}
                    ref={deleteButtonRef}
                    type="button"
                  >
                    {deleteProject.isPending ? (
                      <LoaderCircle aria-hidden="true" className="spin" size={15} />
                    ) : (
                      <Trash2 aria-hidden="true" size={15} />
                    )}
                    <span>{deleteProject.isPending ? "Deleting" : "Delete project"}</span>
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function isProjectOpen(projectId: string) {
  const [, resource, currentProjectId] = window.location.pathname.split("/");
  return resource === "projects" && currentProjectId === projectId;
}
