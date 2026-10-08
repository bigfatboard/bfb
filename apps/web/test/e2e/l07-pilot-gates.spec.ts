// ABOUTME: Verifies the mounted task sheet leaves uncertified pilot surfaces unavailable.
// ABOUTME: Server capability failures never mount review frames or issue held-feature requests.

import { expect, test } from "@playwright/test";

import { V03_TASK } from "../../../../tools/e2e/src/v03-fixture.js";
import { signInAndOpenBoard } from "./helpers.js";

for (const scenario of ["disabled", "pending", "malformed", "unavailable"] as const) {
  test(`pilot surfaces stay closed when configuration is ${scenario}`, async ({ page }) => {
    const heldRequests: string[] = [];
    let releaseConfiguration = () => {};
    const configurationWait = new Promise<void>((resolve) => {
      releaseConfiguration = resolve;
    });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        /\/api\/v1\/workspaces\/[^/]+\/(?:artifacts(?:\/|$)|discussions(?:\/|$)|tasks\/[^/]+\/discussions(?:\/|$))/.test(
          path,
        )
      ) {
        heldRequests.push(path);
      }
    });
    await page.route("**/api/v1/_substrate", async (route) => {
      if (scenario === "pending") await configurationWait;
      await route.fulfill({
        status: scenario === "unavailable" ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          features:
            scenario === "disabled" || scenario === "pending"
              ? { artifact_viewer: false, artifact_review: false, discussions: false }
              : { artifact_viewer: "true", artifact_review: 1, discussions: "true" },
        }),
      });
    });
    await signInAndOpenBoard(page, "owner");
    await page.locator(`#task-${V03_TASK}`).getByRole("button", { name: /Open / }).click();
    await page.getByTestId("task-section").selectOption("artifacts");
    await expect(page.getByTestId("artifact-features-unavailable")).toContainText("Not enabled");
    await page.getByTestId("task-section").selectOption("discussion");
    await expect(page.getByTestId("discussions-unavailable")).toContainText("Not enabled");
    await page.getByTestId("task-section").selectOption("results");
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await page.getByTestId("task-section").selectOption("measurements");
    await expect(page.getByTestId("measurements-panel")).toBeVisible();
    await expect(page.getByTestId("review-panel")).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    // The animation-frame boundary lets already-mounted panel effects run.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(heldRequests).toEqual([]);
    releaseConfiguration();
  });
}
