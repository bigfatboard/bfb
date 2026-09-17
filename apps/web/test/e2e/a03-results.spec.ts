// ABOUTME: Real Playwright browser E2E for the A03 result submission and review cycle.
// ABOUTME: Drives owner submission, reviewer change requests, superseding, and acceptance with screenshots.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { FIX } from "@bfb/domain";

import { openWorkSurface, signInAs } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE_DIR =
  process.env.BFB_CAPTURE_A03_EVIDENCE === "1"
    ? path.join(rootDir, "docs/work-packages/evidence/WP-A03/browser")
    : path.join(rootDir, "apps/web/test/e2e/test-results/evidence-a03");

const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const TASK_TITLE = "A03 result review flow";

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});

test.describe.configure({ mode: "serial" });

async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get("/auth/session");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { csrf_token?: string };
  if (!body.csrf_token) {
    throw new Error("missing csrf token");
  }
  return body.csrf_token;
}

async function api(
  page: Page,
  method: "GET" | "POST",
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const csrf = await csrfToken(page);
  const origin = new URL(page.url()).origin;
  const response = await page.request.fetch(urlPath, {
    method,
    headers: {
      "content-type": "application/json",
      "x-bfb-csrf": csrf,
      origin,
      "sec-fetch-site": "same-origin",
    },
    data: body,
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status(), json: parsed };
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function openTaskSheet(page: Page, taskId: string): Promise<void> {
  await page.locator(`#task-${taskId}`).getByRole("button", { name: /Open / }).click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
}

test("owner submits, reviewer requests changes, owner supersedes and accepts", async ({ page }) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);

  await page.getByRole("button", { name: "New task" }).click();
  await page.getByTestId("create-task-project").selectOption(FIX.projectA);
  await page.getByTestId("create-task-title").fill(TASK_TITLE);
  await page.getByTestId("create-task-form").getByRole("button", { name: "Create task" }).click();
  const card = page.locator(".task-card", { hasText: TASK_TITLE }).first();
  await expect(card).toBeVisible();
  const cardId = await card.getAttribute("id");
  const taskId = (cardId ?? "").replace(/^task-/, "");
  expect(taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  await page.getByRole("button", { name: "Close task" }).click();

  const created = await api(page, "POST", `${BASE}/tasks/${taskId}/runs`, {
    expected_task_version: 1,
    agent_profile_id: FIX.profileCodex,
    workspace_policy_version: 1,
    project_policy_version: 1,
    repository_config_version: 1,
    agent_profile_version: 1,
    request_id: "a03-browser-run-001",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const runId = (
    (created.json.result as { run: { id: string } } | undefined)?.run as { id: string }
  ).id;
  expect(runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

  const submitted = await api(page, "POST", `${BASE}/runs/${runId}/results`, {
    summary: "A03 first browser submission",
    limitations: "Synthetic browser limitation",
    evidence_refs: [{ kind: "comment", ref: "synthetic-browser-comment" }],
    git_branch: "main",
    git_commit: "a".repeat(40),
    git_dirty: false,
    request_id: "a03-browser-submit-001",
  });
  expect(submitted.status).toBe(200);
  const firstSubmissionId = (
    (submitted.json.result as { submission: { id: string } } | undefined)?.submission as {
      id: string;
    }
  ).id;

  await page.reload();
  await openWorkSurface(page);
  await openTaskSheet(page, taskId);
  await expect(page.getByTestId("result-summary")).toContainText("A03 first browser submission");
  await expect(page.getByTestId("result-current")).toBeVisible();
  await expect(page.getByTestId("run-result-row")).toContainText("submitted");
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "review-owner.png"), fullPage: true });

  await signInAs(page, "restricted");
  await openWorkSurface(page);
  await openTaskSheet(page, taskId);
  await expect(page.getByTestId("request-changes-form")).toBeVisible();
  await expect(page.getByTestId("accept-result")).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "review-reviewer.png"), fullPage: true });
  await page.getByTestId("request-changes-comment").fill("Synthetic change request");
  await page.getByTestId("request-changes-submit").click();
  await expect(page.getByTestId("run-result-row")).toContainText("changes requested");
  await settle(page);

  await signInAs(page, "owner");
  await openWorkSurface(page);
  const second = await api(page, "POST", `${BASE}/runs/${runId}/results`, {
    summary: "A03 second browser submission",
    request_id: "a03-browser-submit-002",
  });
  expect(second.status).toBe(200);
  await page.reload();
  await openWorkSurface(page);
  await openTaskSheet(page, taskId);
  await expect(page.getByTestId("result-summary").first()).toContainText(
    "A03 second browser submission",
  );
  await expect(page.getByTestId("result-outdated")).toContainText("a newer version exists");
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "review-superseded.png"),
    fullPage: true,
  });

  await page.getByTestId("accept-result").click();
  await expect(page.getByTestId("run-result-row")).toContainText("accepted");
  await expect(page.getByTestId("accept-result")).toHaveCount(0);
  await expect(page.getByTestId("request-changes-form")).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "review-accepted.png"), fullPage: true });

  await signInAs(page, "restricted");
  await openWorkSurface(page);
  const forbidden = await api(page, "POST", `${BASE}/runs/${runId}/review`, {
    decision: "accept",
    submission_id: firstSubmissionId,
    expected_run_version: 1,
    expected_task_version: 1,
    request_id: "a03-browser-reviewer-accept",
  });
  expect(forbidden.status).toBe(403);

  await writeFile(
    path.join(EVIDENCE_DIR, "review-flow.md"),
    [
      "# A03 browser review flow",
      "",
      `- task: ${taskId}`,
      `- run: ${runId}`,
      "- first submission requested changes by restricted, superseded by version 2, accepted by owner.",
      "- restricted accept attempt rejected with 403.",
      "",
    ].join("\n"),
    "utf8",
  );
});
