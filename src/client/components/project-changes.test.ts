import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProjectChangesResponse } from "../../shared/api";
import { projectChangesQueryKey } from "../query-keys";
import { ProjectChanges } from "./project-changes";

describe("ProjectChanges", () => {
  it("does not report a clean tree when unsupported paths are hidden", () => {
    const projectId = "project-1";
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    queryClient.setQueryData(
      projectChangesQueryKey(projectId),
      {
        entries: [],
        repository: true,
        truncated: false,
        unsupportedEntries: true,
      } satisfies ProjectChangesResponse,
    );

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProjectChanges, {
          projectBusy: false,
          projectId,
          sandboxAvailable: true,
        }),
      ),
    );

    expect(markup).toContain("Some changes are hidden");
    expect(markup).not.toContain("Working tree clean");
  });

  it("does not report a clean tree when the status output is truncated", () => {
    const projectId = "project-1";
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    queryClient.setQueryData(
      projectChangesQueryKey(projectId),
      {
        entries: [],
        repository: true,
        truncated: true,
        unsupportedEntries: false,
      } satisfies ProjectChangesResponse,
    );

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProjectChanges, {
          projectBusy: false,
          projectId,
          sandboxAvailable: true,
        }),
      ),
    );

    expect(markup).toContain("Showing a partial change list");
    expect(markup).not.toContain("Working tree clean");
  });
});
