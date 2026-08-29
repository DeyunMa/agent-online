import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type ReactNode, useCallback } from "react";

import type { MessageResponse } from "../../shared/api";

export function toAssistantUiMessage(message: MessageResponse): ThreadMessageLike {
  return {
    content: [{ text: message.content, type: "text" }],
    createdAt: new Date(message.createdAt),
    id: message.id,
    role: message.role,
    ...(message.role === "assistant"
      ? { status: { reason: "stop" as const, type: "complete" as const } }
      : {}),
  };
}

export function ProjectAssistantRuntimeProvider({
  children,
  isDisabled,
  isRunning,
  messages,
  onCancelRun,
  onSubmitText,
}: {
  children: ReactNode;
  isDisabled: boolean;
  isRunning: boolean;
  messages: readonly MessageResponse[];
  onCancelRun: () => Promise<unknown>;
  onSubmitText: (content: string) => Promise<unknown>;
}) {
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const [part] = message.content;
      if (message.content.length !== 1 || part?.type !== "text") {
        throw new Error("This Project Run only supports plain-text tasks.");
      }

      const content = part.text.trim();
      if (!content) {
        throw new Error("Enter a task for the agent.");
      }

      await onSubmitText(content);
    },
    [onSubmitText],
  );
  const onCancel = useCallback(async () => {
    await onCancelRun();
  }, [onCancelRun]);
  const runtime = useExternalStoreRuntime({
    convertMessage: toAssistantUiMessage,
    isDisabled,
    isRunning,
    messages,
    onCancel,
    onNew,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
