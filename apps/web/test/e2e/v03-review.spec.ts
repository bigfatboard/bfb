// ABOUTME: Real Chromium E2E for the V03 immutable review surface and timer.
// ABOUTME: Drives approval, live publication conflicts, hostile notes, and screenshots.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { FIX } from "@bfb/domain";

import { openWorkSurface, signInAs } from "./helpers.js";
import {
  V03_ARTIFACT,
  V03_HOSTILE_ARTIFACT,
  V03_RUN,
  V03_TASK,
} from "../../../../tools/e2e/src/v03-fixture.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE_DIR =
  process.env.BFB_CAPTURE_V03_EVIDENCE === "1"
    ? path.join(rootDir, "docs/work-packages/evidence/WP-V03/browser")
    : path.join(rootDir, "apps/web/test/e2e/test-results/evidence-v03");

const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const HOSTILE_COMMENT = `</script><script>alert(document.cookie)</script><img src=x onerror=alert(1)>`;

const flowRows: string[] = [];
function record(row: string): void {
  flowRows.push(row);
}

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    path.join(EVIDENCE_DIR, "review-flow.md"),
    [
      "# WP-V03 Review UI browser flow",
      "",
      "Real Chromium drove the task-sheet Review surface against the shared fixture server.",
      "Every row below was observed in this run.",
      "",
      "| Step | Observation |",
      "| --- | --- |",
      ...flowRows,
      "",
    ].join("\n"),
  );
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

async function openReviewSheet(page: Page): Promise<void> {
  await page.locator(`#task-${V03_TASK}`).getByRole("button", { name: /Open / }).click();
  await expect(page.getByTestId("review-panel")).toBeVisible();
}

async function reviewStatus(page: Page, artifactId: string): Promise<Record<string, unknown>> {
  const response = await api(page, "GET", `${BASE}/artifacts/${artifactId}/reviews`);
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
}

test("review surface shows history, approves the exact version, and keeps result state", async ({
  page,
}) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  await openReviewSheet(page);

  await expect(page.getByTestId("review-unapproved")).toBeVisible();
  await expect(page.getByTestId("review-record")).toContainText("Synthetic seed approval of v1.");
  await expect(page.getByTestId("review-record")).toContainText("historical");
  await expect(page.getByTestId("review-hash")).not.toBeEmpty();
  record("| Seed state | v2 unapproved with one historical v1 approval |");

  // The human-controlled timer starts from the Review surface and reads back.
  // Scoped to the review panel: the sheet also carries the standalone A04 panel.
  const panel = page.getByTestId("review-panel");
  await expect(panel.getByTestId("review-timer-start")).toBeVisible();
  await panel.getByTestId("review-timer-start").click();
  await expect(panel.getByTestId("review-timer-stop")).toBeVisible();
  record("| Review timer | explicit start from the Review surface; stop control appears |");

  await page.getByTestId("review-approve").click();
  await expect(page.getByTestId("review-approved")).toBeVisible();
  const status = await reviewStatus(page, V03_ARTIFACT);
  expect(status.approved).toBe(true);
  expect(status.review_count).toBe(2);
  record("| Approve | exact version approved; second review recorded |");

  // Approval never accepts the run result or moves the task.
  const run = await api(page, "GET", `${BASE}/runs/${V03_RUN}`);
  expect(run.status).toBe(200);
  expect((run.json.run as { result_state: string }).result_state).toBe("open");
  const task = await api(page, "GET", `${BASE}/tasks/${V03_TASK}`);
  expect(task.status).toBe(200);
  expect((task.json.task as { state: string }).state).toBe("ready");
  record("| Authority | run still open and task still ready after approval |");

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "review-approved.png"), fullPage: true });
});

test("live publication forces an explicit version conflict with reload", async ({ page }) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  // The sheet loads first so its version triple goes stale on live publish.
  await openReviewSheet(page);
  const before = await reviewStatus(page, V03_ARTIFACT);
  const latestBefore = before.latest_version as { id: string };
  // Pin the loaded surface to the seeded v2 triple before publishing: the
  // seed v2 carries a distinct id prefix no live version can collide with.
  expect(latestBefore.id.startsWith("01JBFBC0")).toBe(true);
  await expect(page.getByTestId("review-version")).toContainText("01JBFBC0");
  const published = await api(page, "POST", "/__test/v03-publish", {});
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  const liveVersion = published.json.version_id as string;
  expect(liveVersion).not.toBe(latestBefore.id);
  record(`| Live publish | new version ${liveVersion.slice(0, 8)} published mid-review |`);

  // The loaded surface still offers the older triple; submitting it conflicts.
  await page.getByTestId("review-approve").click();
  await expect(page.getByTestId("review-error")).toContainText("stale_version");
  await expect(page.getByTestId("review-reload")).toBeVisible();
  record("| Conflict | stale approve rejected with an explicit reload action |");

  await page.getByTestId("review-reload").click();
  await expect(page.getByTestId("review-unapproved")).toBeVisible();
  await page.getByTestId("review-approve").click();
  await expect(page.getByTestId("review-approved")).toBeVisible();
  const after = await reviewStatus(page, V03_ARTIFACT);
  expect(after.approved).toBe(true);
  expect((after.latest_version as { id: string }).id).toBe(liveVersion);
  record("| Recovery | reload shows the live version unapproved; fresh approve lands |");

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "review-conflict.png"), fullPage: true });
});

test("hostile notes stay inert and the preview frame stays sandboxed", async ({ page }) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  await openReviewSheet(page);

  await page.getByTestId("review-artifact-select").selectOption(V03_HOSTILE_ARTIFACT);
  await expect(page.getByTestId("review-unapproved")).toBeVisible();

  await page.getByTestId("review-note").fill(HOSTILE_COMMENT);
  await page.getByTestId("review-comment-submit").click();
  const note = page.getByTestId("review-comment").first();
  await expect(note).toContainText("<script>");
  // The hostile note renders as text: no script element carries its payload.
  await expect(page.locator("script", { hasText: "alert(document.cookie)" })).toHaveCount(0);
  await expect(page.locator("[onerror]")).toHaveCount(0);
  record("| Hostile note | script payload visible only as inert text |");

  // HTML previews wait for an explicit Run preview; the frame then keeps the
  // exact V02 sandbox wiring on the review surface.
  await page.getByTestId("run-preview").click();
  const frame = page.locator('[data-testid="artifact-frame-container"] iframe');
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  const src = await frame.getAttribute("src");
  expect(src).toMatch(/^https:\/\/artifacts\.bfb\.example\.test\/view\//);
  const documentHtml = await page.content();
  expect(documentHtml).not.toContain(HOSTILE_COMMENT);
  record("| Preview frame | exact sandbox wiring; no artifact bytes in trusted DOM |");

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "review-hostile.png"), fullPage: true });
});

test("review duration reads from timer observations, never from presence", async ({ page }) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);

  // Presence observations exist for this task, but the review surface shows
  // only the explicit timer state and A04 durations.
  const presence = await api(page, "POST", `${BASE}/browser-activity`, {
    task_id: V03_TASK,
    started_at: "2026-08-07T09:00:00Z",
    ended_at: "2026-08-07T09:05:00Z",
    request_id: `v03-browser-presence-${Date.now()}`,
  });
  expect(presence.status, JSON.stringify(presence.json)).toBe(200);

  await openReviewSheet(page);
  const panel = page.getByTestId("review-panel");
  const human = panel.getByTestId("measurements-human");
  await expect(human).toBeVisible();
  await expect(human).not.toContainText("5m 00s");
  // Presence stays visible only in its own estimated browser section.
  await expect(panel.getByTestId("measurements-browser")).toContainText("5m");
  const status = await reviewStatus(page, V03_ARTIFACT);
  expect(JSON.stringify(status)).not.toContain("browser_activity");
  expect(JSON.stringify(status)).not.toContain("presence");
  record("| Presence | browser-open time never presented as review time |");
});
