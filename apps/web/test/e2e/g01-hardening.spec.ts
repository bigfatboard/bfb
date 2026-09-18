// ABOUTME: Real Chromium proof for G01 cross-surface browser security.
// ABOUTME: Synthetic fixtures only; the recording keeps counts and states, never content.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, request, test, type Page } from "@playwright/test";

import { FIX } from "@bfb/domain";

import { signInAndOpenBoard, signInAs } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceDir = path.join(rootDir, "docs/work-packages/evidence/WP-G01");
const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const HOSTILE = "</script><script>alert(document.cookie)</script><img src=x onerror=alert(1)>";
const recording: Record<string, unknown> = {
  spec: "g01-hardening",
  scenarios: [] as Array<Record<string, unknown>>,
};

function note(scenario: string, fields: Record<string, unknown> = {}): void {
  (recording.scenarios as Array<Record<string, unknown>>).push({ scenario, ...fields });
}

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    path.join(evidenceDir, "browser-security.json"),
    `${JSON.stringify(recording, null, 2)}\n`,
  );
});

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
  csrf?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrf !== undefined) {
    headers["x-bfb-csrf"] = csrf;
    headers.origin = new URL(page.url()).origin;
    headers["sec-fetch-site"] = "same-origin";
  }
  const response = await page.request.fetch(urlPath, { method, headers, data: body });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status(), json: parsed };
}

async function taskCount(page: Page): Promise<number> {
  const listed = await api(
    page,
    "GET",
    `${BASE}/tasks?limit=100`,
    undefined,
    await csrfToken(page),
  );
  expect(listed.status).toBe(200);
  const tasks = (listed.json.tasks ?? listed.json.items ?? []) as Array<unknown>;
  return tasks.length;
}

test("bearer credentials cannot authenticate browser routes", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const confused = await page.request.fetch(`${BASE}/tasks?limit=1`, {
    headers: { authorization: "Bearer g01-confused-credential" },
  });
  expect(confused.status()).toBe(401);
  expect(await confused.json()).toMatchObject({ error: "credential_confusion" });
  const bare = await request.newContext();
  const anonymous = await bare.fetch(`${new URL(page.url()).origin}${BASE}/tasks?limit=1`);
  expect([401, 403, 404]).toContain(anonymous.status());
  await bare.dispose();
  note("credential-separation", { bearerRejected: 401, anonymousRejected: anonymous.status() });
});

test("mutations without a valid CSRF token fail closed without state change", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const before = await taskCount(page);
  const missing = await api(page, "POST", `${BASE}/tasks`, {
    project_id: FIX.projectA,
    title: "Synthetic G01 CSRF probe",
    priority: "P2",
  });
  expect(missing.status).toBe(403);
  expect(missing.json).toMatchObject({ error: expect.any(String) });
  const forged = await api(
    page,
    "POST",
    `${BASE}/tasks`,
    {
      project_id: FIX.projectA,
      title: "Synthetic G01 CSRF probe",
      priority: "P2",
    },
    "0.deadbeef",
  );
  expect(forged.status).toBe(403);
  expect(await taskCount(page)).toBe(before);
  note("csrf", { missingCsrf: 403, forgedCsrf: 403, taskCountStable: true });
});

test("session cookies are http-only and same-site scoped", async ({ page, context }) => {
  await signInAs(page, "owner");
  const cookies = await context.cookies();
  const session = cookies.filter((cookie) => cookie.name.toLowerCase().includes("session"));
  expect(session.length).toBeGreaterThan(0);
  for (const cookie of session) {
    expect(cookie.httpOnly).toBe(true);
    expect(["Lax", "Strict"]).toContain(cookie.sameSite);
  }
  const values = cookies.map((cookie) => cookie.value).filter((value) => value.length > 0);
  const urls: string[] = [];
  page.on("request", (request) => {
    urls.push(request.url());
  });
  await signInAndOpenBoard(page, "member");
  const leaked = urls.filter((url) =>
    values.some((value) => value.length > 8 && url.includes(value)),
  );
  expect(leaked).toEqual([]);
  note("cookie-hygiene", { sessionCookies: session.length, urlsScanned: urls.length, leaks: 0 });
});

test("hostile task text renders inertly on the board", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const csrf = await csrfToken(page);
  const created = await api(
    page,
    "POST",
    `${BASE}/tasks`,
    {
      project_id: FIX.projectA,
      title: `Synthetic G01 ${HOSTILE}`,
      priority: "P2",
      request_id: "g01-hostile-001",
    },
    csrf,
  );
  expect(created.status).toBe(200);
  await page.reload();
  await expect(page.getByTestId("work-board")).toBeVisible();
  await expect(page.getByText("alert(document.cookie)").first()).toBeVisible();
  await expect(page.locator("script", { hasText: "alert(document.cookie)" })).toHaveCount(0);
  note("hostile-inert", { scriptElements: 0, hostileTextVisible: true });
});
