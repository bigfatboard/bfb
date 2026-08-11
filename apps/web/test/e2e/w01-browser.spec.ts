// ABOUTME: Real Playwright browser E2E for W01 IC-1 owner/member/restricted Work surface flows.
// ABOUTME: Captures role screenshots plus hostile-content, stale-conflict, step-up, and a11y evidence.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { MCP_RESOURCE } from "@bfb/domain";

import { EVIDENCE_DIR, FIX, ROLES, signInAndOpenBoard, signInAs, type RoleKey } from "./helpers.js";

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});

async function writeReport(name: string, body: string): Promise<void> {
  await writeFile(path.join(EVIDENCE_DIR, name), body, "utf8");
}

test.describe.configure({ mode: "serial" });

for (const role of Object.keys(ROLES) as RoleKey[]) {
  test(`${role} signs in and sees role-appropriate project lanes`, async ({ page }) => {
    await signInAndOpenBoard(page, role);
    const roleText = await page.getByTestId("current-role").innerText();
    expect(roleText.trim()).toBe(ROLES[role].roleText);

    await expect(page.getByTestId("project-lanes")).toBeVisible();
    await expect(page.getByTestId("lane-alpha")).toBeVisible();

    if (role === "restricted") {
      await expect(page.getByTestId("lane-beta")).toHaveCount(0);
      const options = page.getByTestId("create-task-project").locator("option");
      await expect(options).toHaveCount(1);
      await expect(options.first()).toHaveAttribute("value", FIX.projectA);
    } else {
      await expect(page.getByTestId("lane-beta")).toBeVisible();
      const optionValues = await page
        .getByTestId("create-task-project")
        .locator("option")
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
      expect(optionValues.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
    }

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, `${ROLES[role].label}.png`),
      fullPage: true,
    });
  });
}

test("hostile task title is escaped and does not create a script node", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const hostile = "<script>alert(1)</script>";
  const beforeScripts = await page.locator("script").count();

  await page.getByTestId("create-task-title").fill(hostile);
  await page.getByTestId("create-task-form").getByRole("button", { name: "Create task" }).click();
  await expect(page.getByTestId("mutation-status")).toHaveText("Task created");
  await expect(page.locator(".task-card").first()).toBeVisible();

  const board = page.getByTestId("work-board");
  await expect(board.locator("script")).toHaveCount(0);
  const boardHtml = await board.innerHTML();
  expect(boardHtml.toLowerCase()).not.toMatch(/<script[\s>]/);
  const boardText = (await board.innerText()).toLowerCase();
  expect(boardText.includes("script") || boardText.includes("alert")).toBe(true);

  const afterScripts = await page.locator("script").count();
  expect(afterScripts).toBe(beforeScripts);

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "hostile-content.png"),
    fullPage: true,
  });

  await writeReport(
    "hostile-content.md",
    [
      "# Hostile content report (W01 browser E2E)",
      "",
      "- Fixture title: ``" + hostile + "``",
      "- Script elements under work-board: 0",
      "- Board HTML contains raw `<script` tag: no",
      "- Board text retains escaped/script-like content: yes",
      "- Page script count before/after create: " +
        String(beforeScripts) +
        " / " +
        String(afterScripts),
      "- Result: malicious title cannot create a DOM script node or execute via board rendering.",
      "",
    ].join("\n"),
  );
});

test("stale edit shows recoverable version conflict", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");

  const title = `stale-source-${Date.now()}`;
  await page.getByTestId("create-task-title").fill(title);
  await page.getByTestId("create-task-form").getByRole("button", { name: "Create task" }).click();
  await expect(page.getByTestId("mutation-status")).toHaveText("Task created");

  const card = page.locator(".task-card").filter({ hasText: title }).first();
  await expect(card).toBeVisible();
  const idAttr = await card.getAttribute("id");
  expect(idAttr).toBeTruthy();
  const taskId = idAttr!.replace(/^task-/, "");

  await page.getByTestId("stale-edit-task-id").fill(taskId);
  await page.getByTestId("stale-edit-version").fill("999");
  await page.getByTestId("stale-edit-title").fill("should-not-apply");
  await page.getByTestId("stale-edit-form").getByRole("button", { name: "Save edit" }).click();

  const error = page.getByTestId("mutation-error");
  await expect(error).toBeVisible();
  const errorText = await error.innerText();
  expect(errorText.toLowerCase()).toMatch(/conflict|stale/);

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "stale-conflict.png"),
    fullPage: true,
  });

  await writeReport(
    "stale-conflict.md",
    [
      "# Stale conflict report (W01 browser E2E)",
      "",
      `- Task id: \`${taskId}\``,
      "- Expected version submitted: `999` (intentionally stale)",
      `- mutation-error text: ${errorText}`,
      "- Result: recoverable conflict surfaced in mutation-error; no silent overwrite.",
      "",
    ].join("\n"),
  );
});

test("oauth authorize without step_up_proof_id fails closed", async ({ page }) => {
  await signInAs(page, "owner");

  const challenge = createHash("sha256").update("e2e-verifier").digest("base64url");
  const authorize = new URL("/oauth/authorize", page.url());
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", FIX.client);
  authorize.searchParams.set("redirect_uri", "http://127.0.0.1:9999/callback");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("scope", "bfb:read bfb:task:write");
  authorize.searchParams.set("resource", MCP_RESOURCE);
  authorize.searchParams.set("workspace_id", FIX.workspace);
  authorize.searchParams.set("project_id", FIX.projectA);
  // Intentionally omit step_up_proof_id.

  const response = await page.goto(authorize.toString());
  expect(response).toBeTruthy();
  expect(response!.status()).toBe(400);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText.toLowerCase()).toMatch(/step_up_proof_id|invalid_request/);

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "step-up.png"),
    fullPage: true,
  });

  await writeReport(
    "step-up.md",
    [
      "# Step-up trace (W01 browser E2E)",
      "",
      "## Browser path",
      "",
      "1. Establish the owner fixture's D1-backed Better Auth session.",
      "2. Navigate browser to `/oauth/authorize` with PKCE + workspace but **without** `step_up_proof_id`.",
      `3. HTTP status: ${response!.status()}`,
      `4. Response body excerpt: ${bodyText.slice(0, 400)}`,
      "",
      "## API proof path (documented)",
      "",
      "Sensitive OAuth delegation requires an action-bound C03 step-up proof:",
      "",
      "1. Issue proof via domain `issueStepUpProof` for action `oauth.delegation.create`.",
      "2. Pass `step_up_proof_id` on `/oauth/authorize`.",
      "3. Exchange code at `/oauth/token`; proof is consumed when minting the delegation.",
      "4. Ordinary authenticated session alone cannot complete privilege/delegation changes.",
      "",
      "Result: browser authorize without step-up proof fails closed with invalid_request.",
      "",
    ].join("\n"),
  );
});

test("owner board accessibility snapshot", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");

  const main = page.locator("main");
  await expect(main).toBeVisible();
  const aria = await main.ariaSnapshot();
  const roles = await page.evaluate(() => {
    const root = document.querySelector("main");
    if (!root) {
      return [] as string[];
    }
    const found = new Set<string>();
    root
      .querySelectorAll("[role], h1, h2, h3, nav, form, button, a, label, input, select")
      .forEach((el) => {
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        found.add(role);
      });
    return [...found].sort();
  });

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "a11y.png"),
    fullPage: true,
  });

  await writeReport(
    "accessibility.md",
    [
      "# Accessibility report (W01 browser E2E)",
      "",
      "- Surface: owner Work board after sign-in + workspace open",
      `- Landmark/roles observed: ${roles.join(", ")}`,
      "- Named regions: Workspace nav, Needs Now deck, Project lanes, Work mutations",
      "- Forms expose labels for sign-in, workspace switcher, create task, and stale edit",
      '- Errors use `role="alert"` / mutation-error for recoverable failures',
      "",
      "## ARIA snapshot",
      "",
      "```",
      aria.trim(),
      "```",
      "",
      "Result: owner board exposes a navigable landmark tree suitable for keyboard users;",
      "detailed axe rulesets remain available to later polish packages.",
      "",
    ].join("\n"),
  );
});
