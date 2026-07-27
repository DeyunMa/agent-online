import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProjectDirectoryResponse } from "../../shared/api";
import { BrowserApiError } from "../api";
import { projectFilesQueryKey } from "../query-keys";
import { ProjectFiles } from "./project-files";

describe("ProjectFiles", () => {
  it("does not render stale directory entries after the sandbox becomes unavailable", async () => {
    const projectId = "project-1";
    const queryKey = projectFilesQueryKey(projectId, "");
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const staleDirectory: ProjectDirectoryResponse = {
      entries: [
        {
          kind: "file",
          modifiedAt: null,
          name: "stale.txt",
          path: "stale.txt",
          size: 5,
        },
      ],
      path: "",
      truncated: false,
    };
    const unavailableError = new BrowserApiError({
      code: "sandbox.not_active",
      message: "sandbox stopped",
      status: 409,
    });

    queryClient.setQueryData(queryKey, staleDirectory);
    await expect(
      queryClient.fetchQuery({
        queryFn: async () => {
          throw unavailableError;
        },
        queryKey,
        staleTime: 0,
      }),
    ).rejects.toBe(unavailableError);

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProjectFiles, {
          hasActiveRun: false,
          projectId,
          sandboxAvailable: true,
        }),
      ),
    );

    expect(markup).toContain("Sandbox not started");
    expect(markup).not.toContain("stale.txt");
  });

  it("does not render or fetch cached files for a stopped sandbox", () => {
    const projectId = "project-1";
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectFilesQueryKey(projectId, ""), {
      entries: [
        {
          kind: "file",
          modifiedAt: null,
          name: "stale.txt",
          path: "stale.txt",
          size: 5,
        },
      ],
      path: "",
      truncated: false,
    } satisfies ProjectDirectoryResponse);

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProjectFiles, {
          hasActiveRun: false,
          projectId,
          sandboxAvailable: false,
        }),
      ),
    );

    expect(markup).toContain("Sandbox not started");
    expect(markup).not.toContain("stale.txt");
    expect(queryClient.isFetching()).toBe(0);
  });
});
