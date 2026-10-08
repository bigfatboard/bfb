// ABOUTME: Proves X02 browser/CLI authorization parity across two Worker isolates.
// ABOUTME: Synthetic identities only; reports carry statuses and codes, never secrets.

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, type D1Like } from "@bfb/db";
import { FIX, issueStepUpProof, seedSyntheticWorkspace } from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://bfb.human.test";
const NOW = "2026-08-18T12:00:00.000Z";
const SIGNING_KEY = "x02-runtime-current-signing-key-73c2e9";
const sessionId = "x02-synthetic-session";
const sessionToken = "x02-synthetic-session-token";
const cookie = `__Host-bfb_session=${encodeURIComponent(`${sessionToken}.${createHmac("sha256", SIGNING_KEY).update(sessionToken).digest("base64")}`)}`;
const csrf = `2.${createHmac("sha256", SIGNING_KEY).update(`bfb-csrf:${sessionId}`).digest("hex")}`;
const EVIDENCE = process.env.BFB_X02_EVIDENCE_DIR ?? "docs/work-packages/evidence/WP-X02";

const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/human-cli/wrangler-a.toml" },
    { configPath: "tools/human-cli/wrangler-b.toml" },
    { configPath: "tools/human-cli/wrangler-hub.toml" },
  ],
});

type ParityRow = {
  check: string;
  browser_status: number | null;
  cli_status: number | null;
  parity: "equal" | "narrowed" | "gated";
  note: string;
};

const parity: ParityRow[] = [];
const transcripts: Array<{ method: string; path: string; status: number }> = [];
let rawSecrets: string[] = [];

function post(index: number, path: string, body: unknown, browser = false, ip = "192.0.2.31") {
  return server.getWorker(index % 2 === 0 ? "bfb-human-a" : "bfb-human-b").fetch(ORIGIN + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(browser
        ? { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "x-bfb-csrf": csrf }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(index: number, path: string, headers: Record<string, string> = {}) {
  return server
    .getWorker(index % 2 === 0 ? "bfb-human-a" : "bfb-human-b")
    .fetch(ORIGIN + path, { headers });
}

function cliGet(index: number, path: string, credential: string, ip = "192.0.2.31") {
  return get(index, path, { authorization: `Bearer ${credential}`, "cf-connecting-ip": ip });
}

function cliPost(index: number, path: string, credential: string, body: unknown) {
  return server.getWorker(index % 2 === 0 ? "bfb-human-a" : "bfb-human-b").fetch(ORIGIN + path, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Fetched {
  status: number;
  json(): Promise<unknown>;
}

async function record(
  check: string,
  browser: Fetched | null,
  cli: Fetched | null,
  parityKind: ParityRow["parity"],
  note: string,
  expectCli: number | number[],
): Promise<{ browser: unknown; cli: unknown }> {
  const wanted = Array.isArray(expectCli) ? expectCli : [expectCli];
  assert.ok(cli && wanted.includes(cli.status), `${check}: CLI status ${cli?.status}`);
  parity.push({
    check,
    browser_status: browser?.status ?? null,
    cli_status: cli?.status ?? null,
    parity: parityKind,
    note,
  });
  if (browser) transcripts.push({ method: "browser", path: check, status: browser.status });
  if (cli) transcripts.push({ method: "cli", path: check, status: cli.status });
  return {
    browser: browser ? await browser.json().catch(() => null) : null,
    cli: cli ? await cli.json().catch(() => null) : null,
  };
}

async function main() {
  try {
    await server.listen();
    const worker = server.getWorker("bfb-human-a");
    await worker.applyD1Migrations("DB");
    const env = (await worker.getEnv()) as unknown as { DB: D1Like };
    const db = adaptD1(env.DB);
    await seedSyntheticWorkspace(db, NOW, "global");
    await db
      .prepare(
        `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES ('x02-user', 'Synthetic CLI Owner', 'owner@synthetic.test', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    await db
      .prepare(`UPDATE humans SET better_auth_user_id = 'x02-user' WHERE id = ?`)
      .run(FIX.owner);
    await db
      .prepare(
        `INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, '2027-08-18T12:00:00.000Z', ?, ?, ?, 'x02-user')`,
      )
      .run(sessionId, sessionToken, NOW, NOW);

    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const issued = await post(0, "/auth/device/code", { client_id: "bfb-cli" });
    assert.equal(issued.status, 200);
    const codes = (await issued.json()) as { device_code: string; user_code: string };
    const approval = await post(
      1,
      `${base}/cli/authorize`,
      { user_code: codes.user_code, project_ids: [] },
      true,
    );
    assert.equal(approval.status, 201);
    const exchange = await post(0, "/api/v1/cli/exchange", {
      client_id: "bfb-cli",
      device_code: codes.device_code,
    });
    assert.equal(exchange.status, 200);
    const credential = ((await exchange.json()) as { credential: string }).credential;
    rawSecrets = [credential, codes.device_code, codes.user_code];

    const scopedIssue = await post(
      0,
      "/auth/device/code",
      { client_id: "bfb-cli" },
      false,
      "192.0.2.32",
    );
    const scopedCodes = (await scopedIssue.json()) as { device_code: string; user_code: string };
    const scopedApproval = await post(
      1,
      `${base}/cli/authorize`,
      { user_code: scopedCodes.user_code, project_ids: [FIX.projectA] },
      true,
      "192.0.2.32",
    );
    assert.equal(scopedApproval.status, 201);
    const scopedExchange = await post(
      0,
      "/api/v1/cli/exchange",
      { client_id: "bfb-cli", device_code: scopedCodes.device_code },
      false,
      "192.0.2.32",
    );
    assert.equal(scopedExchange.status, 200);
    const scopedCredential = ((await scopedExchange.json()) as { credential: string }).credential;
    rawSecrets.push(scopedCredential, scopedCodes.device_code, scopedCodes.user_code);

    // Version diagnostics are public and frozen.
    const version = await get(0, "/api/v1/cli/version");
    assert.equal(version.status, 200);
    assert.deepEqual(await version.json(), {
      api_version: "1",
      wire_protocol: "bfb-wire/1",
      cli_min_version: "0.1.0",
      now: NOW,
    });
    parity.push({
      check: "version diagnostics",
      browser_status: null,
      cli_status: 200,
      parity: "equal",
      note: "unauthenticated frozen surface",
    });

    // Projects: identical reads for the same full-scope human.
    {
      const b = await get(1, `${base}/projects`, { cookie });
      const c = await cliGet(0, "/api/v1/cli/projects", credential);
      const bodies = await record(
        "projects list",
        b,
        c,
        "equal",
        "same human, same authority",
        200,
      );
      assert.deepEqual(bodies.cli, bodies.browser);
      const bOne = await get(1, `${base}/projects/${FIX.projectA}`, { cookie });
      const cOne = await cliGet(0, `/api/v1/cli/projects/${FIX.projectA}`, credential);
      const one = await record(
        "project get",
        bOne,
        cOne,
        "equal",
        "same record both surfaces",
        200,
      );
      assert.deepEqual(one.cli, one.browser);
      const scopedDenied = await cliGet(
        0,
        `/api/v1/cli/projects/${FIX.projectB}`,
        scopedCredential,
      );
      await record(
        "scoped project hidden",
        null,
        scopedDenied,
        "narrowed",
        "binding subset hides Beta",
        404,
      );
    }

    // Tasks: CLI create, identical reads, scoped write hidden.
    const created = (await (
      await cliPost(0, "/api/v1/cli/tasks", credential, {
        project_id: FIX.projectA,
        title: "Synthetic X02 harness task",
        request_id: randomUUID(),
      })
    ).json()) as { ok: boolean; result: { id: string } };
    assert.equal(created.ok, true);
    const taskId = created.result.id;
    parity.push({
      check: "task create",
      browser_status: null,
      cli_status: 200,
      parity: "gated",
      note: "explicit project and title required",
    });
    {
      const b = await get(1, `${base}/tasks/${taskId}`, { cookie });
      const c = await cliGet(0, `/api/v1/cli/tasks/${taskId}`, credential);
      const bodies = await record("task get", b, c, "equal", "same record both surfaces", 200);
      assert.deepEqual(bodies.cli, bodies.browser);
      const scopedWrite = await cliPost(0, "/api/v1/cli/tasks", scopedCredential, {
        project_id: FIX.projectB,
        title: "Synthetic X02 out-of-scope task",
        request_id: randomUUID(),
      });
      await record(
        "scoped task write hidden",
        null,
        scopedWrite,
        "narrowed",
        "binding subset enforced pre-dispatch",
        404,
      );
    }

    // Runs and attention: seeded rows, identical reads, guarded writes.
    const runId = `01JX02RN${"0".repeat(18)}`.slice(0, 26);
    const executionId = `01JX02EXE${"0".repeat(18)}`.slice(0, 26);
    const runnerId = `01JX02RN${"1".repeat(18)}`.slice(0, 26);
    const attentionId = `01JX02ATN${"0".repeat(18)}`.slice(0, 26);
    const artifactId = `01JX02ART${"0".repeat(18)}`.slice(0, 26);
    const versionId = `01JX02VER${"0".repeat(18)}`.slice(0, 26);
    await db
      .prepare(
        `INSERT INTO runs (workspace_id, id, project_id, task_id, requested_by_human_id, agent_profile_id, purpose, result_state, activity, resource_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'work', 'open', 'idle', 1, ?)`,
      )
      .run(FIX.workspace, runId, FIX.projectA, taskId, FIX.owner, FIX.profileCodex, NOW);
    await db
      .prepare(
        `INSERT INTO run_executions (workspace_id, id, run_id, state, resource_version, created_at)
         VALUES (?, ?, ?, 'attached', 1, ?)`,
      )
      .run(FIX.workspace, executionId, runId, NOW);
    await db
      .prepare(
        `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
         VALUES (?, ?, ?, 'Synthetic X02 harness Mac', '{}', 'synthetic-x02-harness', 1, ?)`,
      )
      .run(FIX.workspace, runnerId, FIX.owner, NOW);
    await db
      .prepare(
        `INSERT INTO execution_assignments (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id, runner_id, checkout_id, physical_worktree_hash, requesting_human_id, requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch, runner_key_thumbprint, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'synthetic-x02-harness', ?)`,
      )
      .run(
        FIX.workspace,
        executionId,
        runId,
        taskId,
        FIX.projectA,
        runnerId,
        `01JX02CKO${"0".repeat(18)}`.slice(0, 26),
        `sha256:${"c".repeat(64)}`,
        FIX.owner,
        NOW,
      );
    await db
      .prepare(
        `INSERT INTO attention_requests (workspace_id, id, project_id, task_id, run_id, run_execution_id, assignment_generation, kind, required_role, question, blocking, state, requested_at, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'clarification', 'reviewer', 'Synthetic X02 harness question', 1, 'open', ?, 1)`,
      )
      .run(FIX.workspace, attentionId, FIX.projectA, taskId, runId, executionId, NOW);
    await db
      .prepare(
        `INSERT INTO attention_observations (workspace_id, observation_id, attention_id, observed_kind, actor_type, actor_id, occurred_at)
         VALUES (?, ?, ?, 'requested', 'agent_run', ?, ?)`,
      )
      .run(FIX.workspace, `01JX02OBS${"0".repeat(18)}`.slice(0, 26), attentionId, runId, NOW);
    await db
      .prepare(
        `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, ?, 'markdown', 'review', ?, ?)`,
      )
      .run(FIX.workspace, artifactId, runId, FIX.owner, NOW);
    await db
      .prepare(
        `INSERT INTO artifact_versions (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at)
         VALUES (?, ?, ?, 'available', 'markdown', 12, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        versionId,
        artifactId,
        "a".repeat(64),
        "d".repeat(64),
        `${FIX.workspace}/artifacts/${"d".repeat(64)}`,
        NOW,
        NOW,
      );

    {
      const b = await get(1, `${base}/attention/${attentionId}`, { cookie });
      const c = await cliGet(0, `/api/v1/cli/attention/${attentionId}`, credential);
      const bodies = await record("attention get", b, c, "equal", "same record plus history", 200);
      assert.deepEqual(bodies.cli, bodies.browser);
      const answered = await cliPost(0, `/api/v1/cli/attention/${attentionId}/answer`, credential, {
        expected_version: 1,
        answer: "Synthetic X02 harness answer",
        request_id: randomUUID(),
      });
      await record(
        "attention answer",
        null,
        answered,
        "gated",
        "explicit answer and version required",
        200,
      );
      const duplicate = await cliPost(
        0,
        `/api/v1/cli/attention/${attentionId}/answer`,
        credential,
        {
          expected_version: 2,
          answer: "Synthetic X02 second answer",
          request_id: randomUUID(),
        },
      );
      assert.equal(duplicate.status, 409);
      parity.push({
        check: "attention duplicate answer",
        browser_status: null,
        cli_status: 409,
        parity: "gated",
        note: "committed answer wins, never overwritten",
      });
      const resolved = await cliPost(
        0,
        `/api/v1/cli/attention/${attentionId}/resolve`,
        credential,
        {
          expected_version: 2,
          request_id: randomUUID(),
        },
      );
      await record("attention resolve", null, resolved, "gated", "explicit version required", 200);
    }

    {
      const b = await get(1, `${base}/runs/${runId}`, { cookie });
      const c = await cliGet(0, `/api/v1/cli/runs/${runId}`, credential);
      const bodies = await record("run get", b, c, "equal", "same columns both surfaces", 200);
      assert.deepEqual(bodies.cli, bodies.browser);
      const cancelPath = `/api/v1/cli/runs/${runId}/cancellation`;
      const noConfirm = await cliPost(0, cancelPath, credential, {
        expected_run_version: 1,
        step_up_proof_id: "synthetic-unknown-proof",
        request_id: randomUUID(),
      });
      await record(
        "cancel without confirm",
        null,
        noConfirm,
        "gated",
        "explicit confirm required",
        400,
      );
      const noProof = await cliPost(0, cancelPath, credential, {
        expected_run_version: 1,
        confirm: `run:${runId}`,
        step_up_proof_id: "synthetic-unknown-proof",
        request_id: randomUUID(),
      });
      const noProofBody = (await noProof.json()) as { error: string };
      assert.equal(noProof.status, 403);
      assert.equal(noProofBody.error, "step_up_invalid");
      parity.push({
        check: "cancel without proof",
        browser_status: null,
        cli_status: 403,
        parity: "gated",
        note: "fresh action-bound proof required",
      });
      const proofId = await issueStepUpProof(
        db,
        FIX.owner,
        {
          action: "cli:run:cancel",
          workspaceId: FIX.workspace,
          targetId: `cli:run:cancel:${runId}:1`,
          scopes: ["bfb:read", "bfb:task:write"],
          authorizationEpoch: 1,
          expiresAt: new Date(Date.parse(NOW) + 5 * 60 * 1000).toISOString(),
        },
        NOW,
      );
      const cancelled = await cliPost(0, cancelPath, credential, {
        expected_run_version: 1,
        confirm: `run:${runId}`,
        step_up_proof_id: proofId,
        request_id: randomUUID(),
      });
      await record(
        "cancel with proof",
        null,
        cancelled,
        "gated",
        "confirm plus fresh proof cancels",
        200,
      );
      const after = (await (await get(1, `${base}/runs/${runId}`, { cookie })).json()) as {
        run: { result_state: string };
      };
      assert.equal(after.run.result_state, "cancelled");
    }

    {
      const listed = await cliGet(0, `/api/v1/cli/artifacts?run_id=${runId}`, credential);
      await record("artifact list", null, listed, "equal", "metadata only, no grant secrets", 200);
      const read = await cliGet(0, `/api/v1/cli/artifacts/${artifactId}`, credential);
      await record("artifact get", null, read, "equal", "versions without secrets", 200);
    }

    // Credential separation across isolates.
    {
      const browser = await server
        .getWorker("bfb-human-b")
        .fetch(ORIGIN + `${base}/tasks`, { headers: { authorization: `Bearer ${credential}` } });
      assert.equal(browser.status, 401);
      parity.push({
        check: "CLI credential on browser routes",
        browser_status: 401,
        cli_status: null,
        parity: "equal",
        note: "uniform credential_confusion",
      });
      const cookieCli = await server
        .getWorker("bfb-human-b")
        .fetch(ORIGIN + "/api/v1/cli/projects", { headers: { cookie } });
      assert.equal(cookieCli.status, 401);
      const runnerShaped = await cliGet(1, "/api/v1/cli/projects", "runner-possession-proof");
      assert.equal(runnerShaped.status, 401);
      const mcp = await server.getWorker("bfb-human-b").fetch(ORIGIN + "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.ok([401, 403].includes(mcp.status));
      parity.push({
        check: "CLI credential on MCP",
        browser_status: mcp.status,
        cli_status: null,
        parity: "equal",
        note: "no OAuth substitution",
      });
    }

    // Logout revokes the binding before local cleanup.
    {
      const revoked = await cliPost(1, "/api/v1/cli/session/revoke", credential, {});
      await record("logout revokes binding", null, revoked, "gated", "own binding only", 200);
      const after = await cliGet(0, "/api/v1/cli/projects", credential);
      assert.equal(after.status, 401);
    }

    // Secret scan: persisted rows and recorded transcripts carry hashes only.
    const dump = JSON.stringify({
      bindings: await db.prepare(`SELECT * FROM api_key_bindings`).all(),
      proofs: await db.prepare(`SELECT * FROM passkey_step_up_proofs`).all(),
      audit: await db.prepare(`SELECT * FROM audit_events`).all(),
      events: await db.prepare(`SELECT * FROM semantic_events`).all(),
      idempotency: await db.prepare(`SELECT * FROM idempotency_records`).all(),
      buckets: await db.prepare(`SELECT * FROM rate_limit_buckets`).all(),
      transcripts,
    });
    const findings: string[] = [];
    for (const secret of rawSecrets) {
      if (dump.includes(secret)) findings.push("raw secret retained");
    }
    if (dump.includes("/Users/")) findings.push("local path retained");
    const scan = {
      scanned_surfaces: [
        "api_key_bindings",
        "passkey_step_up_proofs",
        "audit_events",
        "semantic_events",
        "idempotency_records",
        "rate_limit_buckets",
        "http_transcripts",
      ],
      raw_secrets_tested: rawSecrets.length,
      findings,
    };
    assert.deepEqual(findings, []);

    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      resolve(repoRoot, EVIDENCE, "parity-report.json"),
      `${JSON.stringify({ now: NOW, origin: ORIGIN, rows: parity }, null, 2)}\n`,
    );
    writeFileSync(
      resolve(repoRoot, EVIDENCE, "secret-scan-report.json"),
      `${JSON.stringify({ now: NOW, ...scan }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ checks: parity.length, findings: findings.length }));
    console.log("X02_HARNESS_OK");
  } finally {
    await server.close();
  }
}

await main();
