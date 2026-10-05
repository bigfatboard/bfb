// ABOUTME: Generates deterministic synthetic GitHub webhook and REST fixtures for X04.
// ABOUTME: Check mode verifies the committed fixtures match generation without writes.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import prettierConfig from "../../prettier.config.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
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

const HEAD_COMMIT_NEW = {
  id: SHA_NEW,
  tree_id: "e".repeat(40),
  timestamp: NOW,
  message: "Synthetic X04 push",
  author: { name: "Synthetic Author", email: "author@synthetic.test", username: "synthetic-org" },
  committer: {
    name: "Synthetic Author",
    email: "author@synthetic.test",
    username: "synthetic-org",
  },
  url: "https://github.com/synthetic-org/synthetic-repo/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  added: [],
  removed: [],
  modified: ["README.md"],
};
const HEAD_COMMIT_OLD = { ...HEAD_COMMIT_NEW, id: SHA_OLD, timestamp: OLDER };
const PUSH_COMMITS = [
  {
    id: SHA_NEW,
    tree_id: "e".repeat(40),
    message: "Synthetic X04 push",
    timestamp: NOW,
    author: { name: "Synthetic Author", email: "author@synthetic.test" },
    committer: { name: "Synthetic Author", email: "author@synthetic.test" },
    added: [],
    removed: [],
    modified: ["README.md"],
  },
];

const webhooks = {
  "installation.created.json": envelope("installation", "x04-delivery-install-created", {
    action: "created",
    installation: {
      ...INSTALLATION,
      app_id: APP_ID,
      app_slug: "synthetic-app",
      repository_selection: "all",
      permissions: { metadata: "read", pull_requests: "read", checks: "read" },
      events: ["push", "pull_request"],
      created_at: NOW,
      updated_at: NOW,
    },
    repositories: [REPOSITORY],
    requester: null,
    sender: { login: ACCOUNT.login },
  }),
  "installation.deleted.json": envelope("installation", "x04-delivery-install-deleted", {
    action: "deleted",
    installation: { ...INSTALLATION, app_id: APP_ID, app_slug: "synthetic-app", updated_at: NOW },
    repositories: [REPOSITORY],
    sender: { login: ACCOUNT.login },
  }),
  "installation.suspend.json": envelope("installation", "x04-delivery-install-suspend", {
    action: "suspend",
    installation: { ...INSTALLATION, updated_at: NOW },
    repositories: [REPOSITORY],
    sender: { login: ACCOUNT.login },
  }),
  "installation.unsuspend.json": envelope("installation", "x04-delivery-install-unsuspend", {
    action: "unsuspend",
    installation: { ...INSTALLATION, updated_at: NOW },
    repositories: [REPOSITORY],
    sender: { login: ACCOUNT.login },
  }),
  "installation_repositories.added.json": envelope(
    "installation_repositories",
    "x04-delivery-install-repos",
    {
      action: "added",
      installation: INSTALLATION,
      repository_selection: "selected",
      repositories_added: [REPOSITORY],
      repositories_removed: [],
      sender: { login: ACCOUNT.login },
    },
  ),
  "push.main-new.json": envelope("push", "x04-delivery-push-new", {
    ref: "refs/heads/main",
    before: SHA_OLD,
    after: SHA_NEW,
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare:
      "https://github.com/synthetic-org/synthetic-repo/compare/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    commits: PUSH_COMMITS,
    head_commit: HEAD_COMMIT_NEW,
    repository: REPOSITORY,
    pusher: { name: "synthetic-org", email: "pusher@synthetic.test" },
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "push.main-old.json": envelope("push", "x04-delivery-push-old", {
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: SHA_OLD,
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare:
      "https://github.com/synthetic-org/synthetic-repo/compare/0000000000000000000000000000000000000000...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    commits: [{ ...PUSH_COMMITS[0], id: SHA_OLD, timestamp: OLDER }],
    head_commit: HEAD_COMMIT_OLD,
    repository: REPOSITORY,
    pusher: { name: "synthetic-org", email: "pusher@synthetic.test" },
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "push.feature.json": envelope("push", "x04-delivery-push-feature", {
    ref: "refs/heads/feature-x04",
    before: SHA_OLD,
    after: "c".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare:
      "https://github.com/synthetic-org/synthetic-repo/compare/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...cccccccccccccccccccccccccccccccccccccccc",
    commits: [{ ...PUSH_COMMITS[0], id: "c".repeat(40) }],
    head_commit: { ...HEAD_COMMIT_NEW, id: "c".repeat(40) },
    repository: REPOSITORY,
    pusher: { name: "synthetic-org", email: "pusher@synthetic.test" },
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "pull_request.opened.json": envelope("pull_request", "x04-delivery-pr-opened", {
    action: "opened",
    number: 7,
    pull_request: {
      number: 7,
      id: 111222333,
      url: "https://api.github.com/repos/synthetic-org/synthetic-repo/pulls/7",
      head: { sha: SHA_NEW, ref: "feature-x04", label: "synthetic-org:feature-x04" },
      base: { ref: "main", sha: SHA_OLD, label: "synthetic-org:main" },
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
    number: 7,
    pull_request: {
      number: 7,
      id: 111222333,
      url: "https://api.github.com/repos/synthetic-org/synthetic-repo/pulls/7",
      head: { sha: "d".repeat(40), ref: "feature-x04", label: "synthetic-org:feature-x04" },
      base: { ref: "main", sha: SHA_OLD, label: "synthetic-org:main" },
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
      pull_requests: [{ number: 7 }],
      app: { id: APP_ID, slug: "synthetic-app" },
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
      pull_requests: [],
      app: { id: APP_ID, slug: "synthetic-app" },
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "status.success.json": envelope("status", "x04-delivery-status", {
    state: "success",
    sha: SHA_NEW,
    context: "synthetic-ci/status",
    name: "synthetic-ci/status",
    target_url:
      "https://github.com/synthetic-org/synthetic-repo/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/checks",
    description: "Synthetic X04 status",
    updated_at: NOW,
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "issues.opened.json": envelope("issues", "x04-delivery-issue-opened", {
    action: "opened",
    issue: {
      number: 9,
      state: "open",
      title: "Synthetic X04 linked issue",
      updated_at: OLDER,
      id: 444555666,
      user: { login: ACCOUNT.login },
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "issues.closed.json": envelope("issues", "x04-delivery-issue-closed", {
    action: "closed",
    issue: {
      number: 9,
      state: "closed",
      title: "Synthetic X04 linked issue",
      updated_at: NOW,
      id: 444555666,
      user: { login: ACCOUNT.login },
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "deployment.created.json": envelope("deployment", "x04-delivery-deployment", {
    action: "created",
    deployment: {
      id: 6060,
      sha: SHA_NEW,
      environment: "synthetic-staging",
      created_at: NOW,
      creator: { login: ACCOUNT.login },
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: ACCOUNT.login },
  }),
  "deployment_status.success.json": envelope("deployment_status", "x04-delivery-deploy-status", {
    action: "created",
    deployment_status: {
      id: 7070,
      state: "success",
      deployment: { id: 6060 },
      created_at: OLDER,
      updated_at: NOW,
      creator: { login: ACCOUNT.login },
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

async function serialize(value) {
  return format(JSON.stringify(value, null, 2), { ...prettierConfig, parser: "json" });
}

async function writeFixtures() {
  await mkdir(webhooksDir, { recursive: true });
  await mkdir(restDir, { recursive: true });
  for (const [name, value] of Object.entries(webhooks)) {
    await writeFile(resolve(webhooksDir, name), await serialize(value));
  }
  for (const [name, value] of Object.entries(rest)) {
    await writeFile(resolve(restDir, name), await serialize(value));
  }
}

async function checkFixtures() {
  for (const [name, value] of Object.entries(webhooks)) {
    const current = await readFile(resolve(webhooksDir, name), "utf8");
    assert.equal(current, await serialize(value), `fixture drift: fixtures/webhooks/${name}`);
  }
  for (const [name, value] of Object.entries(rest)) {
    const current = await readFile(resolve(restDir, name), "utf8");
    assert.equal(current, await serialize(value), `fixture drift: fixtures/rest/${name}`);
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
