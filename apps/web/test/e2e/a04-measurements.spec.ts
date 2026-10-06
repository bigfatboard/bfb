// ABOUTME: Real Playwright browser E2E for the A04 separated measurements display.
// ABOUTME: Proves missing observations, identity-linked display fixtures, safe overflow and explicit review timers.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { FIX } from "@bfb/domain";

import { openWorkSurface, signInAs } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE_DIR =
  process.env.BFB_CAPTURE_A04_EVIDENCE === "1"
    ? path.join(rootDir, "docs/work-packages/evidence/WP-A04/runtime-browser")
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
  await expect(page.getByTestId("measurements-agent")).toContainText("no observations active");
  await expect(page.getByTestId("measurements-agent")).not.toContainText("0s active");
  await expect(page.getByTestId("measurements-process")).toContainText("no observations alive");
  await expect(page.getByTestId("measurements-external-wait")).toContainText("no observations");
  await expect(page.getByTestId("measurements-idle")).toContainText("no observations");
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
  expect(body.times.process_elapsed_ms).toBeNull();
  expect(body.times.active_quality).toBe("unavailable");
  expect(body.times.external_wait_ms).toBeNull();
  expect(body.times.idle_ms).toBeNull();
  expect(body.tokens.exact.input).toBe(1200);
  expect(body.tokens.unavailable_count).toBe(1);
  expect(body.tokens.catalog_version).toBe("2026-09-01");

  await page
    .getByTestId("measurements-sources")
    .getByText("Measurement sources", { exact: true })
    .click();
  await expect(page.getByTestId("measurements-sources")).toContainText(
    "No identity-linked telemetry sources.",
  );
  await expect(page.getByTestId("measurements-sources")).toContainText(
    "not added to a token grand total",
  );

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
      "- without an observed attach, process/activity and external wait remain no observations; absent idle stays unavailable.",
      "- owner started and stopped the explicit review timer from the sheet; the open timer offered exactly one stop control.",
      "",
    ].join("\n"),
    "utf8",
  );
});

test("observed display sources remain traceable while safe token overflow stays unavailable", async ({
  page,
}) => {
  await signInAs(page, "owner");
  await openWorkSurface(page);
  const seeded = await api(page, "POST", "/__test/a04/observed", {});
  expect(seeded.status, JSON.stringify(seeded.json)).toBe(200);
  const sourceIds = seeded.json.source_ids as string[];
  expect(sourceIds).toHaveLength(4);
  await openDelegableSheet(page);

  await expect(page.getByTestId("measurements-agent")).toContainText("30s active");
  await expect(page.getByTestId("measurements-agent")).toContainText("4m 00s elapsed");
  await expect(page.getByTestId("measurements-external-wait")).toContainText("30s");
  await expect(page.getByTestId("measurements-idle")).toContainText("no observations");
  await expect(page.getByTestId("measurements-overflow")).toContainText(
    "safe counter range exceeded (exact: input)",
  );
  await expect(page.getByTestId("measurements-overflow")).toContainText(
    "Source reports are retained",
  );
  await expect(page.getByTestId("measurements-tokens")).not.toContainText("9,007,199,254,740,991");

  const measured = await api(page, "GET", `${BASE}/runs/${FIX.runDelegable}/measurements`);
  expect(measured.status).toBe(200);
  const view = measured.json.measurements as {
    times: {
      active_ms: number;
      active_quality: string;
      process_alive_ms: number;
      offline_ms: number;
    };
    tokens: { exact: { input: number | null }; exact_overflow_fields: string[] };
  };
  expect(view.times.active_ms).toBe(30_000);
  expect(view.times.active_quality).toBe("observed");
  expect(view.times.process_alive_ms).toBeGreaterThan(0);
  expect(view.times.offline_ms).toBeGreaterThan(0);
  expect(view.tokens.exact.input).toBeNull();
  expect(view.tokens.exact_overflow_fields).toEqual(["input"]);
  const sourcePage = await api(
    page,
    "GET",
    `${BASE}/runs/${FIX.runDelegable}/measurement-sources?limit=100`,
  );
  expect(sourcePage.status).toBe(200);
  const sources = sourcePage.json.sources as Array<{
    event_id: string;
    run_execution_id: string;
    family: string;
  }>;
  expect(sources.map((entry) => entry.event_id).sort()).toEqual([...sourceIds].sort());
  expect(sources.filter((entry) => entry.family === "turn")).toHaveLength(2);
  expect(sources.filter((entry) => entry.family === "tokens")).toHaveLength(2);
  await page
    .getByTestId("measurements-sources")
    .getByText("Measurement sources", { exact: true })
    .click();
  for (const id of sourceIds) {
    await expect(
      page.getByTestId("measurements-sources").getByText(id, { exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "measurements-observed-sources.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByTestId("measurements-panel");
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "measurements-sources-narrow.png"),
    fullPage: true,
  });
});
