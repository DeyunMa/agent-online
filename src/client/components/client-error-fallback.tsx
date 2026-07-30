import { RefreshCw } from "lucide-react";

export function ClientErrorFallback() {
  return (
    <main className="fatal-error-shell" role="alert">
      <div className="fatal-error-content">
        <p className="eyebrow">Agent Online</p>
        <h1>Something went wrong</h1>
        <p>The application could not continue.</p>
        <button className="primary-action" onClick={() => window.location.reload()} type="button">
          <RefreshCw aria-hidden="true" size={16} />
          Reload
        </button>
      </div>
    </main>
  );
}
