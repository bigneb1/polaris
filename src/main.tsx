import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import "./index.css";

import { wagmiConfig } from "./lib/chain";
import { WalletProvider } from "./context/WalletProvider";
import App from "./App";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 4000, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: "rgb(var(--c-card))",
                border: "1px solid rgb(var(--c-border2))",
                color: "rgb(var(--c-text))",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: "13px",
              },
            }}
          />
        </WalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
