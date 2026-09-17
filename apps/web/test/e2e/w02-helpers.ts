// ABOUTME: Shared Playwright helpers for W02 runner and launch operations flows.
// ABOUTME: Real browser sessions drive synthetic C09 launches through the product UI.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page } from "@playwright/test";

import { FIX } from "@bfb/domain";

import { signInAndOpenBoard } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const capturedEvidenceDir = path.join(rootDir, "docs/work-packages/evidence/WP-W02");
const transientEvidenceDir = path.join(rootDir, "apps/web/test/e2e/test-results/evidence-w02");

export const W02_EVIDENCE_DIR =
  process.env.BFB_CAPTURE_W02_EVIDENCE === "1" ? capturedEvidenceDir : transientEvidenceDir;

export async function ensureEvidenceDir(): Promise<void> {
  await mkdir(W02_EVIDENCE_DIR, { recursive: true });
}

export async function writeW02Report(name: string, body: string): Promise<void> {
  await writeFile(path.join(W02_EVIDENCE_DIR, name), body, "utf8");
}

export async function openTaskCard(page: Page, taskId: string, title: string): Promise<void> {
  const card = page.locator(`#task-${taskId}`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `Open ${title}` }).click();
  await expect(page.getByTestId("task-detail")).toBeVisible();
  await expect(page.getByTestId("launch-section")).toBeVisible();
}

export async function openW02Task(page: Page, taskId: string, title: string): Promise<void> {
  await signInAndOpenBoard(page, "owner");
  await openTaskCard(page, taskId, title);
}

export async function waitForStartReady(page: Page): Promise<void> {
  await expect(page.getByTestId("start-button")).toBeEnabled({ timeout: 15_000 });
}

export async function apiFetch(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const session = await fetch("/auth/session");
      const { csrf_token: csrfToken } = (await session.json()) as { csrf_token: string };
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
    { method, path, body },
  );
}

export async function stepUpProof(
  page: Page,
  action: string,
  target: string,
): Promise<{ proof?: string; failure?: string }> {
  return page.evaluate(
    async ({ action, target, workspace }) => {
      const { requestStepUpProof } = await import("/src/auth/webauthn.ts");
      const session = await fetch("/auth/session");
      const { csrf_token: csrfToken } = (await session.json()) as { csrf_token: string };
      try {
        return {
          proof: (await requestStepUpProof(fetch, csrfToken, {
            action,
            targetId: target,
            workspaceId: workspace,
            scopes: [],
            authorizationEpoch: 1,
          })) as string,
        };
      } catch (error) {
        return { failure: error instanceof Error ? error.message : "step-up failed" };
      }
    },
    { action, target, workspace: FIX.workspace },
  );
}

export { FIX };
