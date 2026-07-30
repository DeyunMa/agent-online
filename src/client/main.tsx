import * as Sentry from "@sentry/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { ClientErrorFallback } from "./components/client-error-fallback";
import { initializeClientObservability } from "./observability/sentry";
import { router } from "./router";

initializeClientObservability();

const queryClient = new QueryClient();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ClientErrorFallback />}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
