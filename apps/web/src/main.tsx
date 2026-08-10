// ABOUTME: Browser entrypoint that mounts the authenticated W01 SPA shell into #root.
// ABOUTME: Work surface routing is owned by AppShell against control-plane APIs.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppShell } from "./app.js";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
