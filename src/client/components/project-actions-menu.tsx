import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";

import type { ProjectPageResponse, ProjectResponse } from "../../shared/api";
import { browserApi } from "../api";
import { projectDetailQueryKey, projectQueryKey, userUsageQueryKey } from "../query-keys";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
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
  const inputId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<"delete" | "rename" | null>(null);
  const [title, setTitle] = useState(project.title);
  const renameProject = useMutation({
    mutationFn: (nextTitle: string) => browserApi.updateProject(project.id, { title: nextTitle }),
    onSuccess: async (updatedProject) => {
      queryClient.setQueryData<InfiniteData<ProjectPageResponse>>(projectQueryKey, (projects) =>
        projects
          ? {
              ...projects,
              pages: projects.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === updatedProject.id ? updatedProject : item,
                ),
              })),
            }
          : projects,
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
      queryClient.setQueryData<InfiniteData<ProjectPageResponse>>(projectQueryKey, (projects) =>
        projects
          ? {
              ...projects,
              pages: projects.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== project.id),
              })),
            }
          : projects,
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

  const normalizedTitle = title.trim();
  const renameDisabled =
    renameProject.isPending || normalizedTitle.length === 0 || normalizedTitle === project.title;
  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (renameDisabled) return;
    try {
      await renameProject.mutateAsync(normalizedTitle);
    } catch {
      /* Query exposes the failure in the dialog. */
    }
  }
  return (
    <div className={`project-actions project-actions-${placement}`} data-placement={placement}>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Project actions for ${project.title}`}
          className="project-actions-trigger"
          ref={triggerRef}
          title="Project actions"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal aria-hidden="true" size={17} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={`Project actions for ${project.title}`}>
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setTitle(project.title);
                renameProject.reset();
                setDialog("rename");
              }}
            >
              <Pencil aria-hidden="true" />
              <span>Rename</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                deleteProject.reset();
                setDialog("delete");
              }}
            >
              <Trash2 aria-hidden="true" />
              <span>Delete</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={dialog === "rename"}
        onOpenChange={(open) => {
          if (!open && !renameProject.isPending) setDialog(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          finalFocus={triggerRef}
          initialFocus={() => {
            renameInputRef.current?.select();
            return renameInputRef.current;
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              Update the name shown in Projects, Usage, and the project console.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={(event) => void submitRename(event)}>
            <FieldGroup>
              <Field data-invalid={normalizedTitle.length === 0}>
                <FieldLabel htmlFor={inputId}>Project name</FieldLabel>
                <Input
                  autoComplete="off"
                  disabled={renameProject.isPending}
                  id={inputId}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  ref={renameInputRef}
                  value={title}
                  aria-invalid={normalizedTitle.length === 0}
                />
                {normalizedTitle.length === 0 ? (
                  <FieldError>Enter a project name.</FieldError>
                ) : null}
              </Field>
            </FieldGroup>
            {renameProject.isError ? <ErrorState compact error={renameProject.error} /> : null}
            <DialogFooter>
              <DialogClose disabled={renameProject.isPending} render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button disabled={renameDisabled} type="submit">
                {renameProject.isPending ? (
                  <LoaderCircle aria-hidden="true" className="spin" data-icon="inline-start" />
                ) : null}
                {renameProject.isPending ? "Saving" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={dialog === "delete"}
        onOpenChange={(open) => {
          if (!open && !deleteProject.isPending) setDialog(null);
        }}
      >
        <AlertDialogContent finalFocus={triggerRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{project.title}</strong>? Messages, Agent Runs, and current sandbox
              files will be permanently removed. Aggregate Run usage remains in your all-time
              activity. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteProject.isError ? <ErrorState compact error={deleteProject.error} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProject.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteProject.isPending}
              onClick={() => deleteProject.mutate()}
            >
              {deleteProject.isPending ? (
                <LoaderCircle aria-hidden="true" className="spin" data-icon="inline-start" />
              ) : (
                <Trash2 aria-hidden="true" data-icon="inline-start" />
              )}
              {deleteProject.isPending ? "Deleting" : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function isProjectOpen(projectId: string) {
  const [, resource, currentProjectId] = window.location.pathname.split("/");
  return resource === "projects" && currentProjectId === projectId;
}
