import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { McpConnectionsResponse } from "../../shared/mcp-connections";
import { Button } from "./ui/button";

export function McpConnections() {
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["mcp-connections"],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const response = await fetch(`/api/mcp/connections?cursor=${encodeURIComponent(pageParam)}`);
      if (!response.ok) throw new Error("Could not load connected apps.");
      return (await response.json()) as McpConnectionsResponse;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/mcp/connections/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Could not revoke this connection. Try again.");
    },
    onSuccess: async () => {
      setConfirmId(null);
      await queryClient.invalidateQueries({ queryKey: ["mcp-connections"] });
    },
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <main className="p-6 max-w-3xl mx-auto w-full space-y-5">
      <h1 className="text-2xl font-semibold">Connected apps</h1>
      <p>
        Apps you allowed to read your Agent Online projects and usage. Client names are supplied by
        the apps.
      </p>
      <p>
        Revoking removes stored tokens and consent. Existing access tokens expire within five
        minutes. A known issue may allow an app refreshing at the same time to stay connected.
        Contact the deployment owner if you need access blocked immediately.
      </p>
      {query.isPending ? <p role="status">Loading connected apps…</p> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {revoke.error ? <p role="alert">{revoke.error.message}</p> : null}
      {!query.isPending && !query.error && !items.length ? <p>No connected apps.</p> : null}
      <ul className="space-y-4">
        {items.map((item) => (
          <li key={item.id} className="border rounded-lg p-4 space-y-2">
            <h2 className="font-semibold">{item.name}</h2>
            <p className="text-sm break-all">Client ID: {item.clientId}</p>
            <p>
              Read projects, Run summaries and usage
              {item.scopes.includes("offline_access") ? "; renew access" : ""}.
            </p>
            {confirmId === item.id ? (
              <div className="flex gap-2 items-center">
                <span>Revoke this connection?</span>
                <Button disabled={revoke.isPending} onClick={() => revoke.mutate(item.id)}>
                  Confirm revoke
                </Button>
                <Button
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => setConfirmId(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                disabled={revoke.isPending}
                onClick={() => setConfirmId(item.id)}
              >
                Revoke access
              </Button>
            )}
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Load more
        </Button>
      ) : null}
    </main>
  );
}
