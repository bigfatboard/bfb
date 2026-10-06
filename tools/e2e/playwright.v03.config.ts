// ABOUTME: Runs the compiled immutable-review surface against disposable two-origin Workers.
// ABOUTME: Reuses the isolated viewer browser settings without starting the shared fixture server.

import { defineConfig } from "@playwright/test";
import viewerConfig from "./playwright.v02.config.js";

export default defineConfig({ ...viewerConfig, testMatch: ["v03-runtime.spec.ts"] });
