import { AlertCircle, LoaderCircle } from "lucide-react";

import { BrowserApiError } from "../api";

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle aria-hidden="true" className="spin" size={18} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  compact = false,
  error,
  onRetry,
}: {
  compact?: boolean;
  error: Error;
  onRetry?: () => void;
}) {
  const requestId = error instanceof BrowserApiError ? error.requestId : null;

  return (
    <div className={compact ? "error-state error-state-compact" : "error-state"} role="alert">
      <AlertCircle aria-hidden="true" size={compact ? 15 : 18} />
      <div>
        <p>{error.message}</p>
        {requestId ? <span>请求 ID：{requestId}</span> : null}
      </div>
      {onRetry ? (
        <button className="text-action" onClick={onRetry} type="button">
          重试
        </button>
      ) : null}
    </div>
  );
}
