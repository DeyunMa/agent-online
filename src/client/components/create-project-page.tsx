import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, LoaderCircle, Plus } from "lucide-react";
import { useForm } from "react-hook-form";

import { type CreateProjectRequest, createProjectRequestSchema } from "../../shared/api";

import { browserApi } from "../api";
import { projectQueryKey } from "../query-keys";
import { AppHeaderSlot } from "./app-header-slot";
import { Button } from "./ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { ErrorState } from "./ui-states";

export function CreateProjectPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<CreateProjectRequest>({
    defaultValues: { title: "" },
    resolver: zodResolver(createProjectRequestSchema, {
      error: (issue) => (issue.code === "too_small" ? "Enter a project name." : undefined),
    }),
  });
  const { errors, isSubmitting } = form.formState;
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

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createProject.mutateAsync(values);
    } catch {
      // React Query exposes the request failure next to the form.
    }
  });

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
      <form className="project-form" noValidate onSubmit={(event) => void onSubmit(event)}>
        <FieldGroup>
          <Field data-invalid={!!errors.title} data-disabled={isSubmitting}>
            <FieldLabel htmlFor="project-title">Project name</FieldLabel>
            <Input
              {...form.register("title")}
              autoComplete="off"
              disabled={isSubmitting}
              id="project-title"
              maxLength={120}
              placeholder="acme-dashboard"
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "project-title-error" : undefined}
            />
            <FieldError id="project-title-error" errors={[errors.title]} />
          </Field>
        </FieldGroup>
        {createProject.isError ? <ErrorState compact error={createProject.error} /> : null}
        <div className="form-actions">
          <Link className="secondary-action" to="/">
            Cancel
          </Link>
          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? (
              <LoaderCircle aria-hidden="true" className="spin" data-icon="inline-start" />
            ) : (
              <Plus aria-hidden="true" data-icon="inline-start" />
            )}
            <span>{isSubmitting ? "Creating" : "Create project"}</span>
          </Button>
        </div>
      </form>
    </section>
  );
}
