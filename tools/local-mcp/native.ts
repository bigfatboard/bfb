// ABOUTME: Runs compiled stdio through signed daemon IPC and real local Worker, WorkspaceHub and D1.
// ABOUTME: Seeds only synthetic identities and leaves credentials out of the provider-shaped subprocess.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { adaptD1, type D1Like } from "@bfb/db";
import { FIX, seedSyntheticWorkspace } from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = process.cwd(),
  key = "l08-synthetic-current-signing-key-84d1e9";
const scenario = process.argv[2];
assert.ok(
  scenario === undefined || scenario === "a02" || scenario === "a03" || scenario === "a04",
  "unsupported native fixture scenario",
);
const attention = scenario === "a02";
const results = scenario === "a03";
const measurements = scenario === "a04";
assert.equal(
  process.platform,
  "darwin",
  "native proof requires macOS; do not treat skipped native checks as acceptance",
);
const session = "a01-synthetic-session",
  token = "a01-synthetic-session-token";
const server = createTestHarness({
  root,
  workers: [{ configPath: "tools/local-mcp/wrangler.toml" }],
});
try {
  const { url } = await server.listen(),
    worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  const env = (await worker.getEnv()) as unknown as { DB: D1Like },
    db = adaptD1(env.DB);
  const now = new Date().toISOString();
  await seedSyntheticWorkspace(db, now, "global");
  await db
    .prepare(
      `INSERT INTO better_auth_users (id,name,email,email_verified,created_at,updated_at) VALUES ('a01-user','Synthetic MCP Owner','owner@synthetic.test',1,?,?)`,
    )
    .run(now, now);
  await db
    .prepare(`UPDATE humans SET better_auth_user_id = 'a01-user' WHERE id = ?`)
    .run(FIX.owner);
  await db
    .prepare(
      `INSERT INTO better_auth_sessions (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,'2027-09-12T00:00:00.000Z',?,?,?,'a01-user')`,
    )
    .run(session, token, now, now);
  const attentionEnvironment: Record<string, string> = {};
  if (attention || results) {
    const reviewerSession = "a02-synthetic-reviewer-session",
      reviewerToken = "a02-synthetic-reviewer-token";
    await db
      .prepare(
        `INSERT INTO better_auth_users (id,name,email,email_verified,created_at,updated_at) VALUES ('a02-reviewer','Synthetic Attention Reviewer','reviewer@synthetic.test',1,?,?)`,
      )
      .run(now, now);
    await db
      .prepare("UPDATE humans SET better_auth_user_id='a02-reviewer' WHERE id=?")
      .run(FIX.reviewer);
    await db
      .prepare(
        `INSERT INTO better_auth_sessions (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,'2027-09-12T00:00:00.000Z',?,?,?,'a02-reviewer')`,
      )
      .run(reviewerSession, reviewerToken, now, now);
    attentionEnvironment.BFB_A02_TEST_REVIEWER_COOKIE = `__Host-bfb_session=${encodeURIComponent(`${reviewerToken}.${createHmac("sha256", key).update(reviewerToken).digest("base64")}`)}`;
    attentionEnvironment.BFB_A02_TEST_REVIEWER_CSRF = `2.${createHmac("sha256", key).update(`bfb-csrf:${reviewerSession}`).digest("hex")}`;
  }
  const child = spawn(
    "go",
    ["test", "-race", "-count=1", "-v", "./internal/agentwork", "-run", "^TestNativeAgentWork$"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        BFB_A01_TEST_URL: url.href,
        BFB_A01_TEST_WORKSPACE: FIX.workspace,
        BFB_A01_TEST_PROJECT: FIX.projectA,
        BFB_A01_TEST_COOKIE: `__Host-bfb_session=${encodeURIComponent(`${token}.${createHmac("sha256", key).update(token).digest("base64")}`)}`,
        BFB_A01_TEST_CSRF: `2.${createHmac("sha256", key).update(`bfb-csrf:${session}`).digest("hex")}`,
        BFB_A02_NATIVE_SCENARIO: attention ? "1" : "0",
        BFB_A03_NATIVE_SCENARIO: results ? "1" : "0",
        BFB_A04_NATIVE_SCENARIO: measurements ? "1" : "0",
        ...attentionEnvironment,
      },
    },
  );
  let proved = false,
    proofTail = "";
  child.stdout.on("data", (data: Buffer) => {
    process.stdout.write(data);
    const chunk = proofTail + data.toString();
    if (
      chunk.includes(
        measurements
          ? "A04_NATIVE_PROOF_COMPLETE"
          : results
            ? "A03_NATIVE_PROOF_COMPLETE"
            : attention
              ? "A02_NATIVE_PROOF_COMPLETE"
              : "A01_NATIVE_PROOF_COMPLETE",
      )
    )
      proved = true;
    proofTail = chunk.slice(-128);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, "compiled stdio / authenticated Worker integration failed");
  assert.ok(proved, "native proof did not run; skipped tests are not acceptance");
  console.log(
    `${measurements ? "A04" : results ? "A03" : attention ? "A02" : "A01"} native compiled capture / daemon / possession / Worker / Hub / D1 proof passed`,
  );
} finally {
  await server.close();
}
