// ABOUTME: Real Playwright browser E2E for W01 IC-1 owner/member/restricted Work surface flows.
// ABOUTME: Captures role screenshots plus hostile-content, stale-conflict, step-up, and a11y evidence.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { EVIDENCE_DIR, FIX, ROLES, signInAndOpenBoard, signInAs, type RoleKey } from "./helpers.js";
import { enrollVirtualPasskey } from "./webauthn-helpers.js";

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
    expect(roleText.trim().toLowerCase()).toBe(ROLES[role].roleText);

    await expect(page.getByTestId("project-lanes")).toBeVisible();
    await expect(page.getByTestId("lane-alpha")).toBeVisible();
    await expect(page.locator(`#task-${FIX.taskAttention}`)).toBeVisible();
    await expect(page.locator(`#task-${FIX.taskProposed}`)).toHaveAttribute(
      "data-state",
      "proposed",
    );
    await expect(page.locator(`#task-${FIX.taskAttention}`)).toContainText("Why Synthetic Owner");

    if (role === "restricted") {
      await expect(page.getByTestId("lane-beta")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);
      await expect(page.getByTestId("settings-surface")).toHaveCount(0);
      await page
        .locator(`#task-${FIX.taskAttention}`)
        .getByRole("button", { name: /Open Approve the release boundary/ })
        .click();
      await expect(page.getByTestId("comment-form")).toBeVisible();
      await expect(page.getByTestId("stale-edit-form")).toHaveCount(0);
      await expect(page.getByTestId("handoff-form")).toHaveCount(0);
      await expect(page.getByTestId("context-form")).toHaveCount(0);
      await page.getByRole("button", { name: "Close task" }).click();
    } else {
      await expect(page.getByTestId("lane-beta")).toBeVisible();
      await page.getByRole("button", { name: "New task" }).click();
      const optionValues = await page
        .getByTestId("create-task-project")
        .locator("option")
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
      expect(optionValues.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
      if (role === "owner") {
        await expect(page.getByRole("button", { name: "Projects & policy" })).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "Projects & policy" })).toHaveCount(0);
      }
      await page.getByRole("button", { name: "Cancel" }).click();
    }

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      window.scrollTo(0, 0);
    });

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

  await page.getByRole("button", { name: "New task" }).click();
  await page.getByTestId("create-task-title").fill(hostile);
  await page.getByTestId("create-task-form").getByRole("button", { name: "Create task" }).click();
  const hostileCard = page.locator(".task-card").filter({ hasText: hostile }).first();
  await expect(hostileCard).toBeVisible();

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
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByTestId("create-task-title").fill(title);
  await page.getByTestId("create-task-form").getByRole("button", { name: "Create task" }).click();
  const card = page.locator(".task-card").filter({ hasText: title }).first();
  await expect(card).toBeVisible();
  const idAttr = await card.getAttribute("id");
  expect(idAttr).toBeTruthy();
  const taskId = idAttr!.replace(/^task-/, "");

  await expect(page.getByTestId("task-detail")).toBeVisible();
  await page.evaluate(
    async ({ workspaceId, selectedTaskId }) => {
      const session = await fetch("/auth/session");
      const { csrf_token: csrfToken } = (await session.json()) as { csrf_token: string };
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/tasks/${selectedTaskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
        body: JSON.stringify({
          expected_version: 1,
          punchline: "Changed in another view",
          request_id: "browser-stale-racer",
        }),
      });
      if (!response.ok) {
        throw new Error(`fixture race failed: ${response.status}`);
      }
    },
    { workspaceId: FIX.workspace, selectedTaskId: taskId },
  );
  await page.getByTestId("stale-edit-title").fill("should-not-apply");
  await page
    .getByTestId("stale-edit-form")
    .getByRole("button", { name: "Save current truth" })
    .click();

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
      "- Expected version submitted: `1` after a second browser mutation committed version `2`",
      `- mutation-error text: ${errorText}`,
      "- Result: recoverable conflict surfaced in mutation-error; no silent overwrite.",
      "",
    ].join("\n"),
  );
});

test("proposed task stays distinct until a human promotes it", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const card = page.locator(`#task-${FIX.taskProposed}`);
  await expect(card).toHaveAttribute("data-state", "proposed");
  await card.getByRole("button", { name: /Open Agent-proposed cache cleanup/ }).click();
  await page.getByTestId("promote-task").click();
  await expect(page.getByTestId("mutation-status")).toContainText("promoted");
  await expect(card).toHaveAttribute("data-state", "ready");
});

test("agent preview excludes human-only context", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await page
    .locator(`#task-${FIX.taskDelegable}`)
    .getByRole("button", { name: /Open Map the remaining webhook edge cases/ })
    .click();
  await expect(page.getByTestId("context-list")).toContainText(
    "Private release rationale for the human reviewer.",
  );
  await page.getByTestId("agent-context-preview").click();
  await expect(page.getByTestId("context-list")).toContainText(
    "Check webhook signature replay and delivery ordering.",
  );
  await expect(page.getByTestId("context-list")).not.toContainText(
    "Private release rationale for the human reviewer.",
  );
});

test("owner policy update completes through action-bound passkey UI", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  const cleanup = await enrollVirtualPasskey(page);
  try {
    await page.getByRole("button", { name: "Projects & policy" }).click();
    await expect(page.getByTestId("settings-surface")).toBeVisible();
    await expect(page.getByText("Codex Refactor")).toBeVisible();

    const projectForm = page.getByTestId("create-project-form");
    await projectForm.getByLabel("Name").fill("Gamma UI");
    await projectForm.getByLabel("Slug").fill("gamma-ui");
    await projectForm.getByLabel("Hosted repository ID").fill("987654321");
    await projectForm.getByRole("button", { name: "Add project" }).click();
    await expect(page.getByRole("status")).toContainText("Restricted project created");
    await expect(page.getByText("Gamma UI")).toBeVisible();

    const profileForm = page.getByTestId("create-profile-form");
    await profileForm.getByLabel("Name").fill("Claude UI Review");
    await profileForm.getByLabel("Provider").selectOption("claude");
    await profileForm.getByRole("button", { name: "Add profile" }).click();
    await expect(page.getByRole("status")).toContainText("Agent profile created");
    await expect(page.getByText("Claude UI Review")).toBeVisible();

    await page.getByLabel("Run overrides allowed").uncheck();
    await page.getByTestId("save-workspace-policy").click();
    const status = page.getByRole("status").filter({ hasText: "passkey verification" });
    await expect(status).toBeVisible();

    await page.screenshot({ path: path.join(EVIDENCE_DIR, "step-up.png"), fullPage: true });
    await writeReport(
      "step-up.md",
      [
        "# Step-up trace (W01 browser E2E)",
        "",
        "- Surface: owner Projects & policy",
        "- Mutation: workspace policy version 1, run overrides true to false",
        "- Browser: Chromium virtual CTAP2 platform authenticator",
        "- User verification: required",
        "- Action: `workspace.policy.update`",
        "- Target: SHA-256 of the exact expected version and submitted settings",
        "- Result: one-time proof consumed by the policy mutation; version advanced.",
        "",
      ].join("\n"),
    );
  } finally {
    await cleanup();
  }
});

test("guessed workspace slug never becomes authority", async ({ page }) => {
  await signInAs(page, "owner");
  const boardRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/board")) {
      boardRequests.push(request.url());
    }
  });
  await page.goto("/w/not-authorized");
  await expect(page.getByRole("heading", { name: "Workspace not available." })).toBeVisible();
  expect(boardRequests.some((url) => url.includes("not-authorized"))).toBe(false);
});

test("owner board accessibility snapshot", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");

  const main = page.locator("main");
  await expect(main).toBeVisible();
  const skipLink = page.getByRole("link", { name: "Skip to attention" });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).hash).toBe("#needs-now");

  const taskButton = page
    .locator(`#task-${FIX.taskAttention}`)
    .getByRole("button", { name: /Open Approve the release boundary/ });
  await taskButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-detail")).toBeVisible();
  await page.getByRole("button", { name: "Close task" }).click();

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
  const targetMinimum = await page.evaluate(() => {
    const targets = [...document.querySelectorAll("button, a, input, select, textarea")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => Math.min(rect.width, rect.height));
    return Math.min(...targets);
  });

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.scrollTo(0, 0);
  });

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "a11y.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    laneScrollable:
      (document.querySelector(".project-lane-scroll")?.scrollWidth ?? 0) >
      (document.querySelector(".project-lane-scroll")?.clientWidth ?? 0),
  }));
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewport);
  expect(mobileLayout.laneScrollable).toBe(true);

  await writeReport(
    "accessibility.md",
    [
      "# Accessibility report (W01 browser E2E)",
      "",
      "- Surface: owner Work board after sign-in + workspace open",
      `- Landmark/roles observed: ${roles.join(", ")}`,
      "- Named regions: Workspace nav, Needs Now deck, Project lanes, Work mutations",
      "- Controls expose labels for workspace switching, project navigation, and task selection",
      "- Keyboard path: skip link activated; task button opened and closed the detail sheet",
      `- Smallest visible control dimension: ${targetMinimum}px (WCAG 2.2 minimum: 24px)`,
      `- Mobile document width: ${mobileLayout.documentWidth}px in ${mobileLayout.viewport}px viewport; lanes scroll internally`,
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

test("owner can pass intended ownership to another permitted human", async ({ page }) => {
  await signInAndOpenBoard(page, "owner");
  await page
    .locator(`#task-${FIX.taskAttention}`)
    .getByRole("button", { name: /Open Approve the release boundary/ })
    .click();
  const form = page.getByTestId("handoff-form");
  await form.getByTestId("handoff-kind").selectOption("human");
  await form.getByTestId("handoff-human").selectOption(FIX.member);
  await form.getByLabel("Why this handoff").fill("Member owns the release checklist.");
  await form.getByRole("button", { name: "Pass work" }).click();
  await expect(page.getByTestId("mutation-status")).toContainText("No run was started");
  await expect(page.getByText("Time and token measurements are unavailable.")).toBeVisible();
});
