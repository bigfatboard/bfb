// ABOUTME: Browser entrypoint that mounts the F03 SPA shell into #root.
// ABOUTME: Authenticated Work surface behavior is owned by W01.

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
