import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, LoaderCircle, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";

import { browserApi } from "../api";
import { projectQueryKey } from "../query-keys";
import { AppHeaderSlot } from "./app-header-slot";
import { ErrorState } from "./ui-states";

export function CreateProjectPage() {
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
          disabled={createProject.isPending}
          id="project-title"
          maxLength={120}
          name="title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="acme-dashboard"
          value={title}
        />
        {validationError ? <p className="field-error">{validationError}</p> : null}
        {createProject.isError ? <ErrorState compact error={createProject.error} /> : null}
        <div className="form-actions">
          <Link className="secondary-action" to="/">
            Cancel
          </Link>
          <button className="primary-action" disabled={createProject.isPending} type="submit">
            {createProject.isPending ? (
              <LoaderCircle aria-hidden="true" className="spin" size={16} />
            ) : (
              <Plus aria-hidden="true" size={16} />
            )}
            <span>{createProject.isPending ? "Creating" : "Create project"}</span>
          </button>
        </div>
      </form>
    </section>
  );
}
