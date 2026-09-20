import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessagePageResponse, MessageResponse, TimestampCursor } from "../shared/api";
import { browserApi } from "./api";
import { agentRunsQueryKey, projectMessagesQueryKey, projectQueryKey } from "./query-keys";

export function useProjects() {
  return useInfiniteQuery({
    queryKey: projectQueryKey,
    initialPageParam: undefined as TimestampCursor | undefined,
    queryFn: ({ pageParam }) => browserApi.listProjects(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useRunHistory(projectId: string, enabled: boolean) {
  return useInfiniteQuery({
    enabled,
    queryKey: agentRunsQueryKey(projectId),
    initialPageParam: undefined as TimestampCursor | undefined,
    queryFn: ({ pageParam }) => browserApi.listAgentRuns(projectId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function mergeMessages(current: MessageResponse[], incoming: MessageResponse[]) {
  const bySequence = new Map(current.map((message) => [message.sequence, message]));
  for (const message of incoming) bySequence.set(message.sequence, message);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Messages are immutable: refetch only the tail, retain explicitly loaded history. */
export function useProjectMessages(projectId: string, enabled: boolean) {
  const client = useQueryClient();
  const queryKey = projectMessagesQueryKey(projectId);
  const messages = useQuery({
    enabled,
    queryKey,
    queryFn: async () => {
      const previous = client.getQueryData<MessagePageResponse>(queryKey);
      const latest = previous?.items.at(-1)?.sequence;
      if (!previous || latest === undefined) return browserApi.listMessages(projectId);
      let after = latest;
      let incoming: MessageResponse[] = [];
      let hasMore = true;
      while (hasMore) {
        const page = await browserApi.listMessages(projectId, { after });
        incoming = mergeMessages(incoming, page.items);
        hasMore = page.nextCursor !== null;
        if (page.nextCursor !== null) {
          if (page.nextCursor <= after) throw new Error("Message cursor did not advance");
          after = page.nextCursor;
        }
      }
      const current = client.getQueryData<MessagePageResponse>(queryKey) ?? previous;
      return { ...current, items: mergeMessages(current.items, incoming) };
    },
  });
  const older = useMutation({
    mutationFn: async () => {
      const cursor = client.getQueryData<MessagePageResponse>(queryKey)?.nextCursor;
      return cursor === null || cursor === undefined
        ? null
        : browserApi.listMessages(projectId, { before: cursor });
    },
    onSuccess: (page) => {
      if (!page) return;
      client.setQueryData<MessagePageResponse>(queryKey, (current) => ({
        items: mergeMessages(page.items, current?.items ?? []),
        nextCursor: page.nextCursor,
      }));
    },
  });
  return { ...messages, older };
}
