// ABOUTME: Real Playwright browser E2E for the A04 separated measurements display.
// ABOUTME: Drives owner reads, review-timer start/stop, and screenshots of each section.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { FIX } from "@bfb/domain";

import { openWorkSurface, signInAs } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE_DIR =
  process.env.BFB_CAPTURE_A04_EVIDENCE === "1"
    ? path.join(rootDir, "docs/work-packages/evidence/WP-A04/browser")
    : path.join(rootDir, "apps/web/test/e2e/test-results/evidence-a04");

const BASE = `/api/v1/workspaces/${FIX.workspace}`;

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

async function openDelegableSheet(page: Page): Promise<void> {
  await page
    .locator(`#task-${FIX.taskDelegable}`)
    .getByRole("button", { name: /Open Map the remaining webhook edge cases/ })
    .click();
  await expect(page.getByTestId("measurements-panel")).toBeVisible();
}

test("task sheet keeps human, agent, wait, token, and provenance sections separate", async ({
  page,
}) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  await openDelegableSheet(page);

  await expect(page.getByTestId("measurements-human")).toContainText("4m 00s");
  await expect(page.getByTestId("measurements-attention-latency")).toContainText(
    "awaiting response",
  );
  await expect(page.getByTestId("measurements-browser")).toContainText("5m 00s");
  await expect(page.getByTestId("measurements-agent")).toContainText("0s active");
  await expect(page.getByTestId("measurements-waiting")).toContainText("59m 00s");
  const tokens = page.getByTestId("measurements-tokens");
  await expect(tokens).toContainText("input 1,200");
  await expect(tokens).toContainText("estimated");
  await expect(tokens).toContainText("1 unavailable");
  await expect(page.getByTestId("measurements-provenance")).toContainText("1 review timer");

  const measured = await api(page, "GET", `${BASE}/runs/${FIX.runDelegable}/measurements`);
  expect(measured.status, JSON.stringify(measured.json)).toBe(200);
  const body = measured.json.measurements as {
    times: Record<string, unknown>;
    tokens: { exact: { input: number }; unavailable_count: number; catalog_version: string };
    provenance: Record<string, number>;
  };
  expect(body.times.external_wait_ms).toBe(120_000);
  expect(body.tokens.exact.input).toBe(1200);
  expect(body.tokens.unavailable_count).toBe(1);
  expect(body.tokens.catalog_version).toBe("2026-09-01");

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "measurements-task.png"), fullPage: true });
});

test("owner starts and stops the explicit review timer from the task sheet", async ({ page }) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  await openDelegableSheet(page);

  await page.getByTestId("review-timer-start").click();
  await expect(page.getByTestId("review-timer-stop")).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "measurements-timer-open.png"),
    fullPage: true,
  });

  await page.getByTestId("review-timer-stop").click();
  await expect(page.getByTestId("review-timer-stop")).toHaveCount(0);
  await expect(page.getByTestId("measurements-human")).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "measurements-timer-stopped.png"),
    fullPage: true,
  });

  await writeFile(
    path.join(EVIDENCE_DIR, "measurements-flow.md"),
    [
      "# A04 browser measurements flow",
      "",
      `- task: ${FIX.taskDelegable}`,
      `- run: ${FIX.runDelegable}`,
      "- task sheet shows human review, attention latency, estimated browser activity, agent active/elapsed, attention wait, exact/estimated/unavailable tokens, and provenance as separate sections.",
      "- owner started and stopped the explicit review timer from the sheet; the open timer offered exactly one stop control.",
      "",
    ].join("\n"),
    "utf8",
  );
});
