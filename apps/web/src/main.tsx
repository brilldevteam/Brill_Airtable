import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-sans/700.css";
import "@glideapps/glide-data-grid/dist/index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { DialogProvider } from "./components/Dialogs";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

window.addEventListener("brill:signed-out", () => {
  void queryClient.invalidateQueries({ queryKey: ["me"] });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DialogProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </DialogProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
