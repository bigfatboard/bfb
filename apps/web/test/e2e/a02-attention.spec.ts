// ABOUTME: Real Playwright browser E2E for the A02 ranked cross-project Attention home.
// ABOUTME: Proves deterministic ranking, role-scoped answers, and reload-safe committed state.

import { expect, test } from "@playwright/test";

import { FIX, signInAndOpenBoard } from "./helpers.js";

async function openAttention(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByTestId("attention-home")).toBeVisible();
  await expect(page.getByTestId("attention-list")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("owner sees blocking requests ranked before non-blocking across projects", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  await openAttention(page);
  const items = page.getByTestId("attention-item");
  await expect(items).toHaveCount(4);
  const kinds = await items.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-kind")),
  );
  expect(kinds).toEqual(["blocker", "destructive_action", "credential", "review"]);
  await expect(items.nth(0)).toContainText("Blocking the run");
  await expect(items.nth(0)).toContainText("Synthetic blocker question");
  await expect(items.nth(1)).toContainText("Synthetic destructive-action question");
  await expect(page.getByTestId("attention-home")).toContainText(
    "Provider-native permission dialogs stay separate",
  );
  await expect(page.getByTestId("attention-poll")).toContainText("Committed state as of");
});

test("reviewer answers a review request but cannot satisfy an owner-only credential", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "restricted");
  await openAttention(page);
  const items = page.getByTestId("attention-item");
  await expect(items).toHaveCount(3);
  const kinds = await items.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-kind")),
  );
  expect(kinds).toEqual(["blocker", "credential", "review"]);

  await page.getByTestId(`answer-input-${FIX.attentionReview}`).fill("Synthetic reviewer decision");
  await page
    .getByTestId(`answer-form-${FIX.attentionReview}`)
    .getByRole("button", { name: "Answer" })
    .click();
  const answered = page.locator(`#attention-${FIX.attentionReview}`);
  await expect(answered).toHaveAttribute("data-state", "answered");
  await expect(answered).toContainText("Synthetic reviewer decision");

  await page.getByTestId(`answer-input-${FIX.attentionCredential}`).fill("Synthetic overreach");
  await page
    .getByTestId(`answer-form-${FIX.attentionCredential}`)
    .getByRole("button", { name: "Answer" })
    .click();
  await expect(page.getByTestId("attention-action-error")).toContainText(
    "Your role cannot answer this request",
  );
  await expect(page.locator(`#attention-${FIX.attentionCredential}`)).toHaveAttribute(
    "data-state",
    "open",
  );
});

test("committed answers survive a full reload without any socket delivery", async ({
  page,
}) => {
  await signInAndOpenBoard(page, "owner");
  await openAttention(page);
  await page
    .getByTestId(`answer-input-${FIX.attentionCredential}`)
    .fill("Synthetic reload decision");
  await page
    .getByTestId(`answer-form-${FIX.attentionCredential}`)
    .getByRole("button", { name: "Answer" })
    .click();
  await expect(page.locator(`#attention-${FIX.attentionCredential}`)).toHaveAttribute(
    "data-state",
    "answered",
  );
  await page.reload();
  await expect(page.getByTestId("workspace-switcher")).toBeVisible();
  await page.getByTestId("workspace-switcher").selectOption("synthetic");
  await expect(page.getByTestId("work-board")).toBeVisible();
  await openAttention(page);
  const answered = page.locator(`#attention-${FIX.attentionCredential}`);
  await expect(answered).toHaveAttribute("data-state", "answered");
  await expect(answered).toContainText("Synthetic reload decision");
});
