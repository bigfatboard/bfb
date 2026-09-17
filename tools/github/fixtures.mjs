// ABOUTME: Generates deterministic synthetic GitHub webhook and REST fixtures for X04.
// ABOUTME: Check mode verifies the committed fixtures match generation without writes.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, "../..");
const check = process.argv.includes("--check");
const webhooksDir = resolve(dir, "fixtures/webhooks");
const restDir = resolve(dir, "fixtures/rest");

const NOW = "2026-09-18T12:00:00.000Z";
const OLDER = "2026-09-18T11:55:00.000Z";
const INSTALLATION_ID = 12345678;
const REPOSITORY_ID = 87654321;
const APP_ID = 999000;
const ACCOUNT = { id: 555666, login: "synthetic-org", type: "Organization" };
const REPOSITORY = { id: REPOSITORY_ID, full_name: "synthetic-org/synthetic-repo" };
const INSTALLATION = { id: INSTALLATION_ID, account: ACCOUNT };
const SHA_NEW = "b".repeat(40);
const SHA_OLD = "a".repeat(40);

function envelope(event, delivery, payload) {
  return { event, delivery_id: delivery, payload };
}

const webhooks = {
  "installation.created.json": envelope("installation", "x04-delivery-install-created", {
    action: "created",
    installation: { ...INSTALLATION, app_id: APP_ID, app_slug: "synthetic-app", updated_at: NOW },
    sender: { login: ACCOUNT.login },
  }),
  "installation.deleted.json": envelope("installation", "x04-delivery-install-deleted", {
    action: "deleted",
    installation: { ...INSTALLATION, app_id: APP_ID, app_slug: "synthetic-app", updated_at: NOW },
    sender: { login: ACCOUNT.login },
  }),
  "installation.suspend.json": envelope("installation", "x04-delivery-install-suspend", {
    action: "suspend",
    installation: { ...INSTALLATION, updated_at: NOW },
    sender: { login: ACCOUNT.login },
  }),
  "installation.unsuspend.json": envelope("installation", "x04-delivery-install-unsuspend", {
    action: "unsuspend",
    installation: { ...INSTALLATION, updated_at: NOW },
    sender: { login: ACCOUNT.login },
  }),
  "installation_repositories.added.json": envelope(
    "installation_repositories",
    "x04-delivery-install-repos",
    {
      action: "added",
      installation: INSTALLATION,
      repositories_added: [REPOSITORY],
      repositories_removed: [],
      sender: { login: ACCOUNT.login },
    },
  ),
  "push.main-new.json": envelope("push", "x04-delivery-push-new", {
    ref: "refs/heads/main",
    head_commit: { id: SHA_NEW, timestamp: NOW },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "push.main-old.json": envelope("push", "x04-delivery-push-old", {
    ref: "refs/heads/main",
    head_commit: { id: SHA_OLD, timestamp: OLDER },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "push.feature.json": envelope("push", "x04-delivery-push-feature", {
    ref: "refs/heads/feature-x04",
    head_commit: { id: "c".repeat(40), timestamp: NOW },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "pull_request.opened.json": envelope("pull_request", "x04-delivery-pr-opened", {
    action: "opened",
    pull_request: {
      number: 7,
      head: { sha: SHA_NEW },
      base: { ref: "main" },
      state: "open",
      merged: false,
      title: "Synthetic X04 evidence pull request",
      updated_at: NOW,
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "pull_request.synchronize.json": envelope("pull_request", "x04-delivery-pr-sync", {
    action: "synchronize",
    pull_request: {
      number: 7,
      head: { sha: "d".repeat(40) },
      base: { ref: "main" },
      state: "open",
      merged: false,
      title: "Synthetic X04 evidence pull request",
      updated_at: NOW,
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "check_run.completed.json": envelope("check_run", "x04-delivery-check-run", {
    action: "completed",
    check_run: {
      id: 424242,
      name: "synthetic-ci",
      head_sha: SHA_NEW,
      status: "completed",
      conclusion: "success",
      started_at: OLDER,
      completed_at: NOW,
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "check_suite.completed.json": envelope("check_suite", "x04-delivery-check-suite", {
    action: "completed",
    check_suite: {
      id: 5150,
      head_sha: SHA_NEW,
      status: "completed",
      conclusion: "success",
      created_at: OLDER,
      updated_at: NOW,
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "status.success.json": envelope("status", "x04-delivery-status", {
    state: "success",
    sha: SHA_NEW,
    context: "synthetic-ci/status",
    updated_at: NOW,
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "issues.opened.json": envelope("issues", "x04-delivery-issue-opened", {
    action: "opened",
    issue: { number: 9, state: "open", title: "Synthetic X04 linked issue", updated_at: OLDER },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "issues.closed.json": envelope("issues", "x04-delivery-issue-closed", {
    action: "closed",
    issue: { number: 9, state: "closed", title: "Synthetic X04 linked issue", updated_at: NOW },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "deployment.created.json": envelope("deployment", "x04-delivery-deployment", {
    deployment: { id: 6060, sha: SHA_NEW, environment: "synthetic-staging", created_at: NOW },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "deployment_status.success.json": envelope("deployment_status", "x04-delivery-deploy-status", {
    deployment_status: {
      id: 7070,
      state: "success",
      deployment: { id: 6060 },
      created_at: OLDER,
      updated_at: NOW,
    },
    deployment: { id: 6060 },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
};

const rest = {
  "repository.json": {
    id: REPOSITORY_ID,
    full_name: "synthetic-org/synthetic-repo",
    default_branch: "main",
  },
};

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeFixtures() {
  await mkdir(webhooksDir, { recursive: true });
  await mkdir(restDir, { recursive: true });
  for (const [name, value] of Object.entries(webhooks)) {
    await writeFile(resolve(webhooksDir, name), serialize(value));
  }
  for (const [name, value] of Object.entries(rest)) {
    await writeFile(resolve(restDir, name), serialize(value));
  }
}

async function checkFixtures() {
  for (const [name, value] of Object.entries(webhooks)) {
    const current = await readFile(resolve(webhooksDir, name), "utf8");
    assert.equal(current, serialize(value), `fixture drift: fixtures/webhooks/${name}`);
  }
  for (const [name, value] of Object.entries(rest)) {
    const current = await readFile(resolve(restDir, name), "utf8");
    assert.equal(current, serialize(value), `fixture drift: fixtures/rest/${name}`);
  }
  console.log(
    `X04 fixtures: checked (${Object.keys(webhooks).length} webhooks, ${Object.keys(rest).length} rest)`,
  );
}

if (check) {
  await checkFixtures();
} else {
  await writeFixtures();
  console.log(
    `X04 fixtures: wrote (${Object.keys(webhooks).length} webhooks, ${Object.keys(rest).length} rest)`,
  );
}
