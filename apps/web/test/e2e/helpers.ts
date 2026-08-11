// ABOUTME: Shared Playwright helpers for W01 multi-role sign-in and Work surface navigation.
// ABOUTME: Uses AppShell testids and synthetic FIX credentials against the local E2E server.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page } from "@playwright/test";

import { FIX, SYNTHETIC_PASSWORD } from "@bfb/domain";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export const EVIDENCE_DIR = path.join(rootDir, "docs/work-packages/evidence/WP-W01/browser");

export const ROLES = {
  owner: {
    email: "owner@synthetic.test",
    label: "owner",
    roleText: "owner",
  },
  member: {
    email: "member@synthetic.test",
    label: "member",
    roleText: "member",
  },
  restricted: {
    email: "restricted@synthetic.test",
    label: "restricted",
    roleText: "reviewer",
  },
} as const;

export type RoleKey = keyof typeof ROLES;

export async function signInAs(page: Page, role: RoleKey): Promise<void> {
  const account = ROLES[role];
  await page.goto("/");
  await expect(page.getByTestId("sign-in-form")).toBeVisible();
  await page.getByTestId("sign-in-email").fill(account.email);
  await page.getByTestId("sign-in-password").fill(SYNTHETIC_PASSWORD);
  await page.getByTestId("sign-in-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("current-human")).toBeVisible();
}

export async function openWorkSurface(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-switcher")).toBeVisible();
  await page.getByTestId("workspace-id-input").fill(FIX.workspace);
  await page
    .getByTestId("workspace-switcher")
    .getByRole("button", { name: "Open Work surface" })
    .click();
  await expect(page.getByTestId("work-board")).toBeVisible();
  await expect(page.getByTestId("current-role")).toBeVisible();
}

export async function signInAndOpenBoard(page: Page, role: RoleKey): Promise<void> {
  await signInAs(page, role);
  await openWorkSurface(page);
}

export { FIX, SYNTHETIC_PASSWORD };
