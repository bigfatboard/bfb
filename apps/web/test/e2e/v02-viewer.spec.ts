// ABOUTME: Real Chromium sandbox and CSP proof for V02 hostile previews in iframe and top level.
// ABOUTME: The shared two-origin fixture drives the production worker handler directly.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { expect, test, type Page } from "@playwright/test";

import {
  startV02E2EFixture,
  type V02E2EFixture,
} from "../../../../tools/artifact-viewer/e2e-fixture.js";

const APP_PORT = Number(process.env.BFB_E2E_PORT ?? "4185");
const ART_PORT = Number(process.env.BFB_V02_ARTIFACT_PORT ?? "4186");

let fixture: V02E2EFixture;
let APP = "";
let ART = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await startV02E2EFixture({ appPort: APP_PORT, artPort: ART_PORT });
  APP = fixture.appUrl;
  ART = fixture.artUrl;
});

test.afterAll(async () => {
  const dir = process.env.BFB_V02_EVIDENCE_DIR ?? mkdtempSync(`${tmpdir()}/bfb-v02-browser-`);
  const rows = (globalThis as unknown as { __v02rows?: string[] }).__v02rows ?? [];
  writeFileSync(
    `${dir}/csp-sandbox-report.md`,
    [
      "# WP-V02 CSP and sandbox browser report",
      "",
      "Real Chromium drove hostile previews inside the intended sandboxed iframe and as",
      "directly opened top-level redeemed documents. Every row below was observed in",
      "this run; the self-report channel carries test data only and never authority.",
      "",
      "| Case | Observation |",
      "| --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
  await fixture.close();
});

function record(row: string): void {
  const store = globalThis as unknown as { __v02rows?: string[] };
  store.__v02rows = [...(store.__v02rows ?? []), row];
}

interface ProbeReport {
  attack: string;
  result: string;
}

async function driveIframe(
  page: Page,
  version: string,
  mode = "valid",
): Promise<{ secret: string; viewId: string }> {
  const issued = await fixture.issueGrant(fixture.versions[version]!);
  await page.addInitScript(
    `window.__injectedSecret=${JSON.stringify(issued.secret)};window.__injectedNonce=${JSON.stringify(issued.nonce)};`,
  );
  await page.goto(`${APP}/__test/iframe?view=${issued.view_id}&mode=${mode}`);
  return { secret: issued.secret, viewId: issued.view_id };
}

async function readReports(page: Page, expected: number): Promise<ProbeReport[]> {
  await page.waitForFunction(
    `window.__reports && window.__reports.length >= ${expected}`,
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(2000);
  return (await page.evaluate(
    () => (window as unknown as { __reports: ProbeReport[] }).__reports,
  )).filter((entry) => typeof entry.attack === "string" && typeof entry.result === "string");
}

function resultFor(reports: ProbeReport[], attack: string): string[] {
  const found = reports.filter((entry) => entry.attack === attack).map((entry) => entry.result);
  expect(found.length, `missing probe report for ${attack}`).toBeGreaterThan(0);
  return found;
}

async function expectNoDownload(page: Page): Promise<void> {
  const downloaded = await page
    .waitForEvent("download", { timeout: 1500 })
    .then(
      () => true,
      () => false,
    );
  expect(downloaded, "sandboxed preview must not produce a download").toBe(false);
}

test("iframe hostile HTML stays contained and reaches no app surface", async ({ page }) => {
  const cookiesBefore = fixture.cookieSightings();
  const hitsBefore = fixture.hits.length;
  const { secret } = await driveIframe(page, "html");
  const reports = await readReports(page, 13);
  // The HttpOnly app session cookie is sent same-origin but never reaches the artifact origin.
  await page.evaluate(() => fetch("/__test/hit?t=driver-cookie"));
  await page.waitForTimeout(500);
  const driverHit = fixture.hits.find((entry) => entry.url.includes("t=driver-cookie"));
  expect(driverHit?.cookie).toBe(true);
  expect(fixture.cookieSightings() - cookiesBefore).toBe(0);
  expect(["", "empty-cookie", "blocked-throw"]).toContain(resultFor(reports, "cookie")[0]);
  expect(resultFor(reports, "referrer")).toEqual([""]);
  const location = resultFor(reports, "location")[0]!;
  expect(location.startsWith(`${ART}/view/`)).toBe(true);
  expect(location.includes(secret)).toBe(false);
  expect(resultFor(reports, "history").length).toBeGreaterThan(0);
  expect(resultFor(reports, "api")[0]).toMatch(/^blocked/);
  expect(resultFor(reports, "img")).toEqual(["blocked"]);
  expect(["blocked-null", "blocked-throw"]).toContain(resultFor(reports, "popup")[0]);
  const topnav = resultFor(reports, "topnav")[0]!;
  expect(topnav.startsWith(`${ART}/view/`)).toBe(true);
  expect(topnav.includes("hit")).toBe(false);
  expect(resultFor(reports, "storage")).toEqual(["blocked"]);
  expect(resultFor(reports, "parent-dom")).toEqual(["blocked"]);
  const form = resultFor(reports, "form")[0]!;
  expect(form.startsWith("still-here:")).toBe(true);
  expect(form.includes("hit")).toBe(false);
  await expectNoDownload(page);
  expect(page.url().includes(secret)).toBe(false);
  const hostileHits = fixture.hits.filter((entry) => !entry.url.includes("t=driver-cookie"));
  expect(hostileHits.length - hitsBefore).toBe(0);
  record(
    "| Iframe hostile HTML | cookie empty, referrer empty, URL carries no secret, control API blocked, beacons blocked, popup null, top navigation contained, storage blocked, parent DOM blocked, form still here, no download, zero app hits |",
  );
});

test("iframe hostile SVG stays contained and reaches no app surface", async ({ page }) => {
  const hitsBefore = fixture.hits.length;
  await driveIframe(page, "svg");
  const reports = await readReports(page, 13);
  expect(["", "empty-cookie", "blocked-throw"]).toContain(resultFor(reports, "cookie")[0]);
  expect(resultFor(reports, "api")[0]).toMatch(/^blocked/);
  expect(resultFor(reports, "img")).toEqual(["blocked"]);
  expect(["blocked-null", "blocked-throw"]).toContain(resultFor(reports, "popup")[0]);
  const topnav = resultFor(reports, "topnav")[0]!;
  expect(topnav.startsWith(`${ART}/view/`)).toBe(true);
  expect(resultFor(reports, "storage")).toEqual(["blocked"]);
  expect(resultFor(reports, "parent-dom")).toEqual(["blocked"]);
  await expectNoDownload(page);
  expect(fixture.hits.length - hitsBefore).toBe(0);
  record("| Iframe hostile SVG | cookie empty, API and beacons blocked, popup null, navigation contained, zero app hits |");
});

test("iframe image and rendered markdown load without app contact", async ({ page }) => {
  const hitsBefore = fixture.hits.length;
  const redeemedBefore = fixture.redeemSuccess();
  await driveIframe(page, "png");
  await page.waitForTimeout(2500);
  await driveIframe(page, "markdown");
  await page.waitForTimeout(2500);
  expect(fixture.redeemSuccess() - redeemedBefore).toBe(2);
  expect(fixture.hits.length - hitsBefore).toBe(0);
  record("| Iframe image and markdown | both redemptions succeed, zero app hits |");
});

test("iframe redemption rejects a foreign channel nonce", async ({ page }) => {
  const successBefore = fixture.redeemSuccess();
  const errorBefore = fixture.redeemError();
  await driveIframe(page, "html", "wrong-nonce");
  await page.waitForTimeout(3000);
  expect(fixture.redeemSuccess() - successBefore).toBe(0);
  expect(fixture.redeemError() - errorBefore).toBe(1);
  record("| Iframe wrong nonce | bootstrap submits, server rejects before bytes |");
});

test("iframe redemption ignores messages without a transferred port", async ({ page }) => {
  const successBefore = fixture.redeemSuccess();
  const errorBefore = fixture.redeemError();
  await driveIframe(page, "html", "no-port");
  await page.waitForTimeout(2500);
  expect(fixture.redeemSuccess() - successBefore).toBe(0);
  expect(fixture.redeemError() - errorBefore).toBe(0);
  record("| Iframe message without port | bootstrap ignores it, no redemption attempted |");
});

test("iframe redemption consumes a grant exactly once across messages", async ({ page }) => {
  const successBefore = fixture.redeemSuccess();
  const errorBefore = fixture.redeemError();
  await driveIframe(page, "html", "double");
  await page.waitForTimeout(3000);
  expect(fixture.redeemSuccess() - successBefore).toBe(1);
  expect(fixture.redeemError() - errorBefore).toBe(0);
  record("| Iframe double message | single redemption, second channel message ignored |");
});

interface TopProbe {
  cookie: string;
  referrer: string;
  api: string;
  navScheduled: string;
  location: string;
  popup: string;
  afterForm: string;
  storage: string;
  scripts: number;
  history: number;
}

async function openTopLevel(page: Page, version: string): Promise<{ secret: string; viewId: string }> {
  const issued = await fixture.issueGrant(fixture.versions[version]!);
  await page.addInitScript(
    `window.__injectedSecret=${JSON.stringify(issued.secret)};window.__injectedNonce=${JSON.stringify(issued.nonce)};`,
  );
  // The driver auto-submits the redemption form, so commit (not load) is the
  // stable wait point; the redeemed URL is then polled because hostile
  // documents can disturb navigation load states.
  await page.goto(`${APP}/__test/toplevel?view=${issued.view_id}`, { waitUntil: "commit" });
  await expect
    .poll(async () => page.url(), { timeout: 20000 })
    .toBe(`${ART}/view/${issued.view_id}/redeem`);
  expect(page.url().includes(issued.secret)).toBe(false);
  return { secret: issued.secret, viewId: issued.view_id };
}

async function probeTopLevel(page: Page): Promise<TopProbe> {
  return page.evaluate(
    async (app: string) => {
      const out = {} as Record<string, string | number>;
      try {
        out.cookie = document.cookie || "empty-cookie";
      } catch {
        out.cookie = "blocked-throw";
      }
      out.referrer = document.referrer;
      try {
        await fetch(`${app}/__test/hit?t=api`);
        out.api = "fetched";
      } catch (error) {
        out.api = `blocked:${error instanceof Error ? error.name : "unknown"}`;
      }
      try {
        location.href = `${app}/__test/hit?t=topnav`;
        out.navScheduled = "no-throw";
      } catch {
        out.navScheduled = "throw";
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      out.location = location.href;
      try {
        const opened = window.open(`${app}/__test/hit?t=popup`);
        out.popup = opened === null ? "blocked-null" : "opened";
      } catch {
        out.popup = "blocked-throw";
      }
      const form = document.createElementNS("http://www.w3.org/1999/xhtml", "form");
      form.method = "POST";
      form.action = `${app}/__test/hit?t=form`;
      (document.body || document.documentElement).appendChild(form);
      try {
        form.submit();
      } catch {
        // Blocked submissions stay on the redeemed document.
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      out.afterForm = location.href;
      try {
        localStorage.setItem("x", "1");
        out.storage = "writable";
      } catch {
        out.storage = "blocked";
      }
      out.scripts = document.querySelectorAll("script").length;
      out.history = history.length;
      return out as unknown as TopProbe;
    },
    APP,
  );
}

function hitsSince(index: number): Array<{ url: string; referer: string; cookie: boolean }> {
  return fixture.hits.slice(index);
}

function expectNoExfiltration(hits: Array<{ url: string; referer: string; cookie: boolean }>, secret: string): void {
  // Fetch, beacons, images, popups, forms, and downloads never send a
  // request. Top-level self-navigation may issue a bare GET that commits away
  // from the hostile document; it must carry no credential, no referrer, and
  // no secret, and the 204 targets below prove the hostile page keeps no
  // footing when the target answers without content.
  for (const vector of ["t=api", "t=img", "t=popup", "t=form", "t=download"]) {
    expect(hits.filter((entry) => entry.url.includes(vector)), vector).toEqual([]);
  }
  for (const entry of hits) {
    expect(entry.cookie, entry.url).toBe(false);
    expect(entry.referer.includes(secret), entry.url).toBe(false);
    expect(entry.url.includes(secret), entry.url).toBe(false);
  }
}

test("top-level hostile HTML remains constrained by the response sandbox", async ({ page }) => {
  const hitsBefore = fixture.hits.length;
  const { secret, viewId } = await openTopLevel(page, "html");
  const probe = await probeTopLevel(page);
  expect(["", "empty-cookie", "blocked-throw"]).toContain(probe.cookie);
  expect(probe.referrer).toBe("");
  expect(probe.api).toMatch(/^blocked/);
  expect(probe.location).toBe(`${ART}/view/${viewId}/redeem`);
  expect(["blocked-null", "blocked-throw"]).toContain(probe.popup);
  expect(probe.afterForm).toBe(`${ART}/view/${viewId}/redeem`);
  expect(probe.storage).toBe("blocked");
  expect(probe.scripts).toBeGreaterThan(0);
  await expectNoDownload(page);
  expectNoExfiltration(hitsSince(hitsBefore), secret);
  record("| Top-level hostile HTML | cookie empty, referrer empty, network/forms/popups/downloads send nothing, self-navigation carries no credential or secret, page keeps no attacker footing |");
});

test("top-level hostile SVG remains constrained by the response sandbox", async ({ page }) => {
  const hitsBefore = fixture.hits.length;
  const { secret, viewId } = await openTopLevel(page, "svg");
  const probe = await probeTopLevel(page);
  expect(["", "empty-cookie", "blocked-throw"]).toContain(probe.cookie);
  expect(probe.api).toMatch(/^blocked/);
  expect(probe.location).toBe(`${ART}/view/${viewId}/redeem`);
  expect(probe.afterForm).toBe(`${ART}/view/${viewId}/redeem`);
  expectNoExfiltration(hitsSince(hitsBefore), secret);
  record("| Top-level hostile SVG | cookie empty, network/forms/popups send nothing, self-navigation carries no credential or secret |");
});

test("top-level rendered markdown is inert text under the same policy", async ({ page }) => {
  await openTopLevel(page, "markdown");
  const probe = await probeTopLevel(page);
  expect(probe.scripts).toBe(0);
  expect(["", "empty-cookie", "blocked-throw"]).toContain(probe.cookie);
  expect(probe.api).toMatch(/^blocked/);
  const html = await page.evaluate(() => document.documentElement.innerHTML);
  expect(html).toContain("synthetic review");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script");
  record("| Top-level markdown | no script elements, hostile markup visible only as escaped text |");
});

test("top-level strict mermaid drops active lines and caps huge diagrams", async ({ page }) => {
  await openTopLevel(page, "mermaid");
  const hostile = await page.evaluate(() => document.documentElement.innerHTML);
  expect(hostile).toContain("omitted");
  expect(hostile).not.toContain("javascript:");
  expect(await page.evaluate(() => document.querySelectorAll("a").length)).toBe(0);
  await openTopLevel(page, "mermaidHuge");
  const fallback = await page.evaluate(() => document.body.innerText);
  expect(fallback.toLowerCase()).toContain("preview unavailable");
  record("| Top-level mermaid | active directives dropped without links, over-cap diagram falls back fast |");
});

test("top-level image loads under the same policy", async ({ page }) => {
  await openTopLevel(page, "png");
  expect(await page.evaluate(() => document.contentType)).toBe("image/png");
  expect(["", "empty-cookie", "blocked-throw"]).toContain(
    await page.evaluate(() => {
      try {
        return document.cookie || "empty-cookie";
      } catch {
        return "blocked-throw";
      }
    }),
  );
  const api = await page.evaluate(async (app: string) => {
    try {
      await fetch(`${app}/__test/hit?t=api`);
      return "fetched";
    } catch {
      return "blocked";
    }
  }, APP);
  expect(api).toBe("blocked");
  record("| Top-level image | image document loads, cookie empty, network blocked |");
});
