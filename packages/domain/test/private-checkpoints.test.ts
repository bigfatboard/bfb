// ABOUTME: Proves owner-private progress reads, OAuth origin separation and immutable minimal receipts.
// ABOUTME: Exercises current task ceilings and staged/cache/final-selection losses without activating private creation.

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it } from "vitest";
import { bumpMemberEpoch, loadPrincipal } from "../src/authorization.js";
import { resolveCommand } from "../src/command-catalog.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubContext } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { selectNotificationEvent } from "../src/notifications.js";
import { readSecurityAudit } from "../src/operations.js";
import {
  capturePublicBusinessAuthority,
  finalizePublicBusinessResult,
  withPublicBusinessAuthority,
  type PublicBusinessAuthority,
} from "../src/public-business.js";
import {
  assertPrivateProgressReceipt,
  readPrivateProgress,
  reportPrivateProgressCommand,
  type PrivateProgressReceipt,
  type ReportPrivateProgressInput,
} from "../src/private-checkpoints.js";
import { createTaskCommand } from "../src/work-commands.js";
import { issueSyntheticMcpAccess, openDomainDb } from "./helpers.js";
import { resultStagedD1 } from "./result-fixture.js";

const DENIED = { code: "not_found", message: "private progress not found" };
const BODY = "Synthetic author-private checkpoint";
let db: SqlDatabase, taskId: string, otherTaskId: string, privateTaskId: string, grantId: string;
let member: PublicBusinessAuthority;

function success<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.ok, outcome.ok ? "committed" : outcome.error.code).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}
function value(target = taskId, body = BODY): ReportPrivateProgressInput {
  return { taskId: target, body };
}
function request(input: ReportPrivateProgressInput, authority = member, key = randomUlid()) {
  return {
    workspaceId: FIX.workspace,
    actorHumanId: authority.humanId,
    ...(authority.credential?.kind === "delegation"
      ? { actorDelegationId: authority.credential.delegationId }
      : {}),
    authorizationEpoch: authority.authorizationEpoch,
    idempotencyKey: key,
    input: withPublicBusinessAuthority(reportPrivateProgressCommand, input, authority),
  };
}
function execute(input = value(), authority = member, key = randomUlid(), database = db) {
  return new WorkspaceHub(database).execute(
    reportPrivateProgressCommand,
    request(input, authority, key),
  );
}
async function oauth(
  scopes = ["bfb:read", "bfb:task:write", "offline_access"],
  taskBoundary?: string,
  humanId = FIX.member,
) {
  const { delegationId } = await issueSyntheticMcpAccess(db, {
    humanId,
    scopes,
    ...(taskBoundary ? { taskId: taskBoundary } : {}),
  });
  return capturePublicBusinessAuthority(db, {
    workspaceId: FIX.workspace,
    actorHumanId: humanId,
    actorDelegationId: delegationId,
    authorizationEpoch: 1,
  });
}
async function snapshot() {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const rows: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (["sqlite_sequence", "d1_migrations"].includes(name)) continue;
    expect(name.startsWith("sqlite_") || name.startsWith("_cf_")).toBe(false);
    rows[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return rows;
}
function beforeRead(
  database: SqlDatabase,
  pattern: RegExp,
  change: () => Promise<void>,
  afterSelection = false,
) {
  let fired = false;
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    prepare(sql) {
      const statement = source.prepare(sql);
      const cut = async () => {
        if (!fired && pattern.test(sql)) {
          fired = true;
          await change();
        }
      };
      return {
        run: (...params) => statement.run(...params),
        get: async (...params) => {
          if (!afterSelection) await cut();
          const result = await statement.get(...params);
          if (afterSelection) await cut();
          return result;
        },
        all: async (...params) => {
          if (!afterSelection) await cut();
          const result = await statement.all(...params);
          if (afterSelection) await cut();
          return result;
        },
      };
    },
    withTransaction: (fn) => source.withTransaction((tx) => fn(wrap(tx))),
  });
  return { db: wrap(database), fired: () => fired };
}

const NATURAL_EXPIRY_DELAY_MS = 3_200;
type NaturalCredential = Record<string, unknown> & { id: string; expires_at: string };

async function naturalOauth(
  modifier: "+3 seconds" | "+10 minutes",
  scopes = ["bfb:read", "bfb:task:write", "offline_access"],
) {
  const window = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS issued_at, strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(modifier)) as { issued_at: string; expires_at: string };
  // Synthetic OAuth issuance metadata uses the real helper and an initial SQL-clock window.
  // These domain tests do not authenticate or exchange a bearer token.
  const { delegationId } = await issueSyntheticMcpAccess(db, {
    humanId: FIX.member,
    taskId: privateTaskId,
    scopes,
    now: window.issued_at,
    expiresAt: window.expires_at,
  });
  const authority = await capturePublicBusinessAuthority(db, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    actorDelegationId: delegationId,
    authorizationEpoch: 1,
  });
  const credential = (await db
    .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, delegationId)) as NaturalCredential;
  return { authority, credential };
}

async function credentialClock(credential: NaturalCredential) {
  const current = await db
    .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, credential.id);
  expect(current).toEqual(credential);
  return (await db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
       julianday(expires_at)>julianday('now') AS live
       FROM oauth_delegations WHERE workspace_id=? AND id=?`,
    )
    .get(FIX.workspace, credential.id)) as { database_now: string; live: number };
}

async function naturalDelay(credential: NaturalCredential, liveAfter: boolean) {
  expect(
    (await credentialClock(credential)).live,
    "credential must be live at the reached boundary",
  ).toBe(1);
  await delay(NATURAL_EXPIRY_DELAY_MS);
  const witness = await credentialClock(credential);
  expect(witness.live).toBe(liveAfter ? 1 : 0);
  if (!liveAfter)
    expect(Date.parse(witness.database_now)).toBeGreaterThanOrEqual(
      Date.parse(credential.expires_at),
    );
  return witness;
}

function observeCheckpointWrites(database: SqlDatabase) {
  let observedAt = "",
    guarded = false;
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    prepare(sql) {
      const statement = source.prepare(sql);
      return {
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        run: async (...params) => {
          const result = await statement.run(...params);
          // The staged adapter has now prepared and bound these original writes.
          if (sql.includes("INSERT INTO task_private_checkpoints")) {
            expect(typeof params.at(-1)).toBe("string");
            observedAt = params.at(-1) as string;
          }
          if (sql.includes("INSERT INTO artifact_mutation_guards")) guarded = true;
          return result;
        },
      };
    },
    withTransaction: (work) => source.withTransaction((tx) => work(wrap(tx))),
  });
  return { db: wrap(database), observedAt: () => observedAt, guarded: () => guarded };
}

async function expectCheckpointCommit(
  before: Record<string, unknown>,
  receipt: PrivateProgressReceipt,
  observedAt: string,
  credential: NaturalCredential,
) {
  const after = await snapshot();
  const added = [
    "task_private_checkpoints",
    "semantic_events",
    "audit_events",
    "outbox_records",
    "idempotency_records",
  ];
  for (const table of Object.keys(before)) {
    if (added.includes(table)) {
      const prior = before[table] as Record<string, unknown>[];
      const current = after[table] as Record<string, unknown>[];
      expect(current.slice(0, prior.length), table).toEqual(prior);
      expect(current, table).toHaveLength(prior.length + 1);
      expect(current.at(-1)?.created_at, table).toBe(observedAt);
      if (table !== "task_private_checkpoints")
        expect(JSON.stringify(current), table).not.toContain(BODY);
    } else if (table === "workspace_cursors") {
      expect(after[table]).toEqual(
        (before[table] as Array<{ workspace_id: string; cursor: number }>).map((row) =>
          row.workspace_id === FIX.workspace ? { ...row, cursor: row.cursor + 1 } : row,
        ),
      );
    } else expect(after[table], table).toEqual(before[table]);
  }
  expect(Object.keys(receipt).sort()).toEqual(["checkpoint_id", "content_hash", "task_id"]);
  expect(
    await db
      .prepare("SELECT * FROM task_private_checkpoints WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, receipt.checkpoint_id),
  ).toEqual({
    workspace_id: FIX.workspace,
    id: receipt.checkpoint_id,
    task_id: privateTaskId,
    project_id: FIX.projectA,
    owner_human_id: FIX.member,
    origin_delegation_id: credential.id,
    origin_client_id: credential.client_id,
    body: BODY,
    content_hash: receipt.content_hash,
    created_at: observedAt,
  });
  return after;
}
async function revokeGrant() {
  await db
    .prepare(
      "UPDATE task_human_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=?",
    )
    .run(FIX.workspace, grantId);
}
async function loseProject() {
  await db
    .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
  await db
    .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
    .run(FIX.workspace, FIX.projectA, FIX.member);
}
async function rawCheckpoint(
  owner = FIX.member,
  delegationId: string | null = null,
  clientId: string | null = null,
  createdAt = "2026-10-08T12:00:00.000Z",
) {
  const id = randomUlid();
  // Synthetic retained history is used only for lookahead and origin filtering controls.
  await db
    .prepare(
      `INSERT INTO task_private_checkpoints
    (workspace_id,id,task_id,project_id,owner_human_id,origin_delegation_id,origin_client_id,body,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      id,
      taskId,
      FIX.projectA,
      owner,
      delegationId,
      clientId,
      BODY,
      "sha256:" +
        createHash("sha256")
          .update(JSON.stringify({ body: BODY }))
          .digest("hex"),
      createdAt,
    );
  return id;
}

beforeEach(async () => {
  db = await openDomainDb();
  const create = async (humanId: string, title: string) =>
    success(
      await new WorkspaceHub(db).execute(createTaskCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: humanId,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, title, priority: "P2" },
      }),
    ).id;
  taskId = await create(FIX.member, "Synthetic checkpoint task");
  otherTaskId = await create(FIX.member, "Synthetic other checkpoint task");
  privateTaskId = await create(FIX.owner, "Synthetic private parent task");
  // Private creation remains disabled; the retained policy and named contribution are fixture-only.
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, privateTaskId, FIX.owner, "2026-10-08T12:00:00.000Z");
  grantId = randomUlid();
  await db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'contribute',?)",
    )
    .run(FIX.workspace, grantId, privateTaskId, FIX.member, "2026-10-08T12:00:00.000Z");
  member = await loadPrincipal(db, FIX.workspace, FIX.member);
});

describe("author-private checkpoints", () => {
  it("registers the command and retains only minimal immutable receipts and safe Hub metadata", async () => {
    expect(resolveCommand("progress.private.report")).toBe(reportPrivateProgressCommand);
    const before = await snapshot();
    const receipt = success(await execute(value(taskId, "  " + BODY + "  ")));
    expect(Object.keys(receipt).sort()).toEqual(["checkpoint_id", "content_hash", "task_id"]);
    expect(receipt).toMatchObject({
      task_id: taskId,
      content_hash:
        "sha256:" +
        createHash("sha256")
          .update(JSON.stringify({ body: BODY }))
          .digest("hex"),
    });
    const result = await readPrivateProgress(db, member, taskId);
    expect(result).toEqual({
      task_id: taskId,
      checkpoints: [
        {
          id: receipt.checkpoint_id,
          body: BODY,
          content_hash: receipt.content_hash,
          created_at: expect.any(String),
          origin: "human",
        },
      ],
      has_more: false,
    });
    const after = await snapshot();
    const changed = [
      "task_private_checkpoints",
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
      "workspace_cursors",
    ];
    for (const table of Object.keys(before))
      if (!changed.includes(table)) expect(after[table], table).toEqual(before[table]);
    for (const table of [
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
    ]) {
      expect(JSON.stringify(after[table])).not.toContain(BODY);
      expect((after[table] as unknown[]).length).toBe((before[table] as unknown[]).length + 1);
    }
    expect(
      selectNotificationEvent("progress.private.report", {
        input: { task_id: taskId },
        result: receipt,
      }),
    ).toBeNull();
    expect(
      (
        await readSecurityAudit(db, FIX.workspace, {
          access: await loadPrincipal(db, FIX.workspace, FIX.owner),
        })
      ).entries,
    ).toEqual([]);
  });
  it("returns a useful authorized-empty view without any read effects", async () => {
    const before = await snapshot();
    expect(await readPrivateProgress(db, member, taskId)).toEqual({
      task_id: taskId,
      checkpoints: [],
      has_more: false,
    });
    expect(await snapshot()).toEqual(before);
  });
  it("does not share another author's history through shared or creator-private task access", async () => {
    success(await execute());
    success(await execute(value(privateTaskId)));
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    expect((await readPrivateProgress(db, owner, taskId)).checkpoints).toEqual([]);
    expect((await readPrivateProgress(db, owner, privateTaskId)).checkpoints).toEqual([]);
    expect((await readPrivateProgress(db, member, privateTaskId)).checkpoints).toHaveLength(1);
    await revokeGrant();
    await expect(readPrivateProgress(db, member, privateTaskId)).rejects.toMatchObject(DENIED);
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM task_private_checkpoints").get(),
    ).toEqual({ count: 2 });
  });
  it("uses the same denied parent answer for missing, foreign and private-ungranted tasks", async () => {
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner),
      before = await snapshot();
    for (const [scope, id] of [
      [member, randomUlid()],
      [{ ...member, workspaceId: randomUlid() }, taskId],
      [await loadPrincipal(db, FIX.workspace, FIX.reviewer), privateTaskId],
    ] as const)
      await expect(readPrivateProgress(db, scope, id)).rejects.toMatchObject(DENIED);
    expect((await readPrivateProgress(db, owner, privateTaskId)).checkpoints).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
  it("allows Reviewer reporting but a private read grant cannot contribute", async () => {
    const reviewer = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
    success(await execute(value(), reviewer));
    expect((await readPrivateProgress(db, reviewer, taskId)).checkpoints).toHaveLength(1);
    await db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
      )
      .run(FIX.workspace, randomUlid(), privateTaskId, FIX.reviewer, "2026-10-08T12:00:00.000Z");
    expect(await readPrivateProgress(db, reviewer, privateTaskId)).toMatchObject({
      checkpoints: [],
    });
    expect(await execute(value(privateTaskId), reviewer)).toMatchObject({
      ok: false,
      error: DENIED,
    });
  });
  it("allows write-only OAuth receipts without granting checkpoint read access", async () => {
    const delegated = await oauth(["bfb:task:write", "offline_access"]);
    const receipt = success(await execute(value(), delegated));
    await expect(
      assertPrivateProgressReceipt(db, delegated, receipt, value()),
    ).resolves.toBeUndefined();
    await expect(readPrivateProgress(db, delegated, taskId)).rejects.toMatchObject(DENIED);
    expect((await readPrivateProgress(db, member, taskId)).checkpoints[0]).toMatchObject({
      origin: "delegation",
    });
  });
  it("allows read-only OAuth to read its retained origin but not to append", async () => {
    const delegated = await oauth();
    success(await execute(value(), delegated));
    await db
      .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
      .run(
        JSON.stringify(["bfb:read", "offline_access"]),
        FIX.workspace,
        delegated.credential!.kind === "delegation" ? delegated.credential!.delegationId : "",
      );
    const readOnly = {
      ...delegated,
      credential: { ...delegated.credential!, scopes: ["bfb:read", "offline_access"] },
    } as PublicBusinessAuthority;
    expect((await readPrivateProgress(db, readOnly, taskId)).checkpoints).toHaveLength(1);
    expect(await execute(value(), readOnly)).toMatchObject({ ok: false, error: DENIED });
  });
  it("separates delegations with the same sponsor/client while humans retain origin-revoked history", async () => {
    const first = await oauth(),
      second = await oauth();
    const a = success(await execute(value(taskId, "Synthetic first delegation checkpoint"), first));
    const b = success(
      await execute(value(taskId, "Synthetic second delegation checkpoint"), second),
    );
    success(await execute());
    expect((await readPrivateProgress(db, first, taskId)).checkpoints.map(({ id }) => id)).toEqual([
      a.checkpoint_id,
    ]);
    expect((await readPrivateProgress(db, second, taskId)).checkpoints.map(({ id }) => id)).toEqual(
      [b.checkpoint_id],
    );
    const credential = first.credential!;
    if (credential.kind !== "delegation") throw new Error("expected OAuth origin");
    await db
      .prepare(
        "UPDATE oauth_delegations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=?",
      )
      .run(FIX.workspace, credential.delegationId);
    await expect(readPrivateProgress(db, first, taskId)).rejects.toMatchObject(DENIED);
    expect((await readPrivateProgress(db, member, taskId)).checkpoints).toHaveLength(3);
  });
  it("filters author and origin before newest-first ordering and the 100-row lookahead", async () => {
    const delegated = await oauth(),
      origin = delegated.credential!;
    if (origin.kind !== "delegation") throw new Error("expected OAuth origin");
    const first = await rawCheckpoint();
    await rawCheckpoint(FIX.owner, null, null, "2027-01-01T00:00:00.000Z");
    for (let index = 0; index < 100; index++)
      await rawCheckpoint(FIX.member, origin.delegationId, origin.clientId);
    const direct = await readPrivateProgress(db, member, taskId),
      remote = await readPrivateProgress(db, delegated, taskId);
    expect(direct.checkpoints).toHaveLength(100);
    expect(direct.has_more).toBe(true);
    expect(direct.checkpoints.some(({ id }) => id === first)).toBe(false);
    expect(remote.checkpoints).toHaveLength(100);
    expect(remote.has_more).toBe(false);
    expect(direct.checkpoints.every(({ origin }) => origin === "delegation")).toBe(true);
    const history = (await db
      .prepare(
        "SELECT id FROM task_private_checkpoints WHERE owner_human_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
      )
      .all(FIX.member)) as Array<{ id: string }>;
    expect(direct.checkpoints.map(({ id }) => id)).toEqual(history.map(({ id }) => id));
  });
  it("retains exact retries, canonical normalization and changed-input rejection", async () => {
    const key = randomUlid(),
      original = await execute(value(taskId, " " + BODY + " "), member, key);
    const before = await snapshot();
    expect(await execute(value(), member, key)).toEqual({ ...original, replayed: true });
    expect(await execute(value(taskId, "Synthetic changed checkpoint"), member, key)).toMatchObject(
      { ok: false, error: { code: "request_rejected" } },
    );
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a substituted canonical receipt belonging to another author, origin or body", async () => {
    const receipt = success(await execute());
    await expect(
      assertPrivateProgressReceipt(db, member, receipt, value()),
    ).resolves.toBeUndefined();
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner),
      delegated = await oauth();
    const otherAuthor = success(await execute(value(), owner)),
      otherOrigin = success(await execute(value(), delegated));
    for (const changed of [
      otherAuthor,
      otherOrigin,
      { ...receipt, checkpoint_id: randomUlid() },
      { ...receipt, task_id: otherTaskId },
      { ...receipt, content_hash: receipt.content_hash + "\n" },
    ])
      await expect(
        assertPrivateProgressReceipt(db, member, changed, value()),
      ).rejects.toMatchObject(DENIED);
    await expect(
      assertPrivateProgressReceipt(db, member, receipt, value(taskId, "Synthetic different body")),
    ).rejects.toMatchObject(DENIED);
  });
  it.each([
    { taskId: "bad", body: BODY },
    { taskId: "trailing", body: BODY },
    { taskId: "valid", body: "" },
    { taskId: "valid", body: "x".repeat(2049) },
    { taskId: "valid", body: "x\nsecret" },
    { taskId: "valid", body: "x\u0000secret" },
    { taskId: "valid", body: "x\u007fsecret" },
    { taskId: "valid", body: 1 },
    { taskId: "valid", body: BODY, ownerHumanId: FIX.owner },
    { taskId: "valid", body: BODY, originDelegationId: randomUlid() },
    { taskId: "valid", body: BODY, audience: "agent" },
    { taskId: "valid", body: BODY, runId: randomUlid() },
  ])("rejects closed/bounded input %j before effects", async (input) => {
    const supplied = {
      ...input,
      taskId:
        input.taskId === "valid"
          ? taskId
          : input.taskId === "trailing"
            ? taskId + "\n"
            : input.taskId,
    } as ReportPrivateProgressInput;
    const before = await snapshot();
    expect(await execute(supplied)).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(await snapshot()).toEqual(before);
  });
  it("accepts the Unicode body bound and rejects alternate actor labels in direct command.run", async () => {
    success(await execute(value(taskId, "🙂".repeat(2048))));
    const context: HubContext = {
      db,
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      now: new Date().toISOString(),
      cursorBase: 0,
    };
    const before = await snapshot();
    for (const alternate of [
      { actorSystemId: "" },
      { actorRunnerId: "" },
      { actorDelegationId: "" },
    ])
      await expect(
        reportPrivateProgressCommand.run(value(), { ...context, ...alternate }),
      ).rejects.toMatchObject(DENIED);
    expect(await snapshot()).toEqual(before);
  });
  it("does not adopt write scope gained after the original transport capture", async () => {
    const delegated = await oauth(["bfb:read", "offline_access"]),
      credential = delegated.credential!;
    if (credential.kind !== "delegation") throw new Error("expected OAuth origin");
    await db
      .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
      .run(
        JSON.stringify(["bfb:read", "bfb:task:write", "offline_access"]),
        FIX.workspace,
        credential.delegationId,
      );
    const before = await snapshot();
    expect(await execute(value(), delegated)).toMatchObject({ ok: false, error: DENIED });
    expect(await snapshot()).toEqual(before);
  });
  it("does not widen an originally empty project vector", async () => {
    const before = await snapshot();
    expect(await execute(value(), { ...member, projectIds: [] })).toMatchObject({
      ok: false,
      error: DENIED,
    });
    await expect(
      readPrivateProgress(db, { ...member, projectIds: [] }, taskId),
    ).rejects.toMatchObject(DENIED);
    expect(await snapshot()).toEqual(before);
  });
});

describe("checkpoint late authority fences", () => {
  it.each([
    "grant",
    "project",
    "epoch",
    "membership",
    "delegation",
    "scope",
    "boundary",
    "expiry",
  ] as const)(
    "rolls back every staged effect after independent %s loss before batch",
    async (kind) => {
      const delegated = await oauth(),
        credential = delegated.credential!;
      if (credential.kind !== "delegation") throw new Error("expected OAuth origin");
      let baseline: Record<string, unknown> | undefined,
        fired = false;
      const staged = resultStagedD1(db, async () => {
        fired = true;
        if (kind === "grant") await revokeGrant();
        else if (kind === "project") await loseProject();
        else if (kind === "epoch") await bumpMemberEpoch(db, FIX.workspace, FIX.member);
        else if (kind === "membership") {
          // Membership removal clears its dependent project grants before deleting the member.
          await db
            .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
            .run(FIX.workspace, FIX.member);
          await db
            .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
            .run(FIX.workspace, FIX.member);
        } else {
          const [column, selected] =
            kind === "delegation"
              ? ["revoked_at", new Date().toISOString()]
              : kind === "scope"
                ? ["scopes_json", "[]"]
                : kind === "boundary"
                  ? ["task_id", otherTaskId]
                  : ["expires_at", "2000-01-01T00:00:00.000Z"];
          await db
            .prepare(`UPDATE oauth_delegations SET ${column}=? WHERE workspace_id=? AND id=?`)
            .run(selected, FIX.workspace, credential.delegationId);
        }
        baseline = await snapshot();
      });
      expect(await execute(value(privateTaskId), delegated, randomUlid(), staged.db)).toMatchObject(
        { ok: false, error: { code: "command_failed" } },
      );
      expect(fired).toBe(true);
      expect(await snapshot()).toEqual(baseline);
    },
  );
  it.each(["grant", "epoch", "delegation", "scope"] as const)(
    "withholds cached receipts after the actual cache SELECT is reached and %s changes",
    async (kind) => {
      const delegated = await oauth(),
        credential = delegated.credential!;
      if (credential.kind !== "delegation") throw new Error("expected OAuth origin");
      const key = randomUlid();
      success(await execute(value(privateTaskId), delegated, key));
      let baseline: Record<string, unknown> | undefined;
      const cut = beforeRead(
        resultStagedD1(db).db,
        /SELECT command_name, result_json FROM idempotency_records/,
        async () => {
          if (kind === "grant") await revokeGrant();
          else if (kind === "epoch") await bumpMemberEpoch(db, FIX.workspace, FIX.member);
          else
            await db
              .prepare(
                `UPDATE oauth_delegations SET ${kind === "delegation" ? "revoked_at" : "scopes_json"}=? WHERE workspace_id=? AND id=?`,
              )
              .run(
                kind === "delegation" ? new Date().toISOString() : "[]",
                FIX.workspace,
                credential.delegationId,
              );
          baseline = await snapshot();
        },
      );
      expect(await execute(value(privateTaskId), delegated, key, cut.db)).toMatchObject({
        ok: false,
        error: DENIED,
      });
      expect(cut.fired()).toBe(true);
      expect(await snapshot()).toEqual(baseline);
    },
  );
  it.each([false, true])(
    "keeps an empty=%s final read denied after original capture and late task-grant loss",
    async (empty) => {
      if (!empty) success(await execute(value(privateTaskId)));
      let baseline: Record<string, unknown> | undefined;
      const cut = beforeRead(db, /private_checkpoint_task AS MATERIALIZED/, async () => {
        await revokeGrant();
        baseline = await snapshot();
      });
      await expect(readPrivateProgress(cut.db, member, privateTaskId)).rejects.toMatchObject(
        DENIED,
      );
      expect(cut.fired()).toBe(true);
      expect(await snapshot()).toEqual(baseline);
    },
  );
  it("retains committed history but withholds a receipt at the explicit final public result selection", async () => {
    const input = value(privateTaskId),
      receipt = success(await execute(input));
    await revokeGrant();
    const before = await snapshot();
    await expect(
      finalizePublicBusinessResult(
        reportPrivateProgressCommand,
        withPublicBusinessAuthority(reportPrivateProgressCommand, input, member),
        receipt,
        {
          db,
          workspaceId: FIX.workspace,
          actorHumanId: FIX.member,
          authorizationEpoch: 1,
          now: new Date().toISOString(),
          cursorBase: 0,
        },
      ),
    ).rejects.toMatchObject(DENIED);
    expect(await snapshot()).toEqual(before);
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM task_private_checkpoints").get(),
    ).toEqual({ count: 1 });
  });
  it("rolls back all effects when unchanged delegation metadata naturally expires after the original bound batch is reached", async () => {
    const { authority, credential } = await naturalOauth("+3 seconds");
    const before = await snapshot();
    let expiredAtBatch = false;
    let observed!: ReturnType<typeof observeCheckpointWrites>;
    const staged = resultStagedD1(db, async () => {
      expect(observed.guarded()).toBe(true);
      expect(Date.parse(observed.observedAt())).toBeLessThan(Date.parse(credential.expires_at));
      await naturalDelay(credential, false);
      expiredAtBatch = true;
    });
    observed = observeCheckpointWrites(staged.db);
    expect(await execute(value(privateTaskId), authority, randomUlid(), observed.db)).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    // Hub maps batch errors: this outside witness prevents an early probe error from passing.
    expect(expiredAtBatch).toBe(true);
    expect(observed.guarded()).toBe(true);
    expect((await credentialClock(credential)).live).toBe(0);
    expect(await snapshot()).toEqual(before);
  }, 15_000);
  it("commits a write-only checkpoint after the same bound-batch delay while retaining the original occurrence time", async () => {
    const { authority, credential } = await naturalOauth("+10 minutes", [
      "bfb:task:write",
      "offline_access",
    ]);
    const before = await snapshot();
    let liveAtFlush = false,
      flushAt = "";
    let observed!: ReturnType<typeof observeCheckpointWrites>;
    const staged = resultStagedD1(db, async () => {
      expect(observed.guarded()).toBe(true);
      const witness = await naturalDelay(credential, true);
      flushAt = witness.database_now;
      liveAtFlush = true;
    });
    observed = observeCheckpointWrites(staged.db);
    const outcome = await execute(value(privateTaskId), authority, randomUlid(), observed.db);
    const receipt = success(outcome);
    expect(outcome).toMatchObject({ replayed: false });
    expect(liveAtFlush).toBe(true);
    expect(Date.parse(flushAt) - Date.parse(observed.observedAt())).toBeGreaterThanOrEqual(3_000);
    const committed = await expectCheckpointCommit(
      before,
      receipt,
      observed.observedAt(),
      credential,
    );
    expect((await readPrivateProgress(db, member, privateTaskId)).checkpoints).toEqual([
      {
        id: receipt.checkpoint_id,
        body: BODY,
        content_hash: receipt.content_hash,
        created_at: observed.observedAt(),
        origin: "delegation",
      },
    ]);
    await expect(readPrivateProgress(db, authority, privateTaskId)).rejects.toMatchObject(DENIED);
    expect((await credentialClock(credential)).live).toBe(1);
    expect(await snapshot()).toEqual(committed);
  }, 15_000);
  it("withholds current checkpoint reads when unchanged delegation metadata expires after the final SQL is prepared", async () => {
    const { authority, credential } = await naturalOauth("+3 seconds");
    const receipt = success(await execute(value(privateTaskId), authority));
    const before = await snapshot();
    let expiredBeforeSelection = false;
    const cut = beforeRead(db, /private_checkpoint_task AS MATERIALIZED/, async () => {
      await naturalDelay(credential, false);
      expiredBeforeSelection = true;
    });
    await expect(readPrivateProgress(cut.db, authority, privateTaskId)).rejects.toMatchObject(
      DENIED,
    );
    expect(cut.fired()).toBe(true);
    expect(expiredBeforeSelection).toBe(true);
    expect((await readPrivateProgress(db, member, privateTaskId)).checkpoints[0]?.id).toBe(
      receipt.checkpoint_id,
    );
    expect(await snapshot()).toEqual(before);
  }, 15_000);
  it("withholds an exact cached checkpoint receipt when unchanged delegation metadata expires after the actual cache row returns", async () => {
    const { authority, credential } = await naturalOauth("+3 seconds");
    const key = randomUlid();
    const receipt = success(await execute(value(privateTaskId), authority, key));
    const before = await snapshot();
    expect(
      await execute(value(privateTaskId), authority, key, resultStagedD1(db).db),
    ).toMatchObject({
      ok: true,
      result: receipt,
      replayed: true,
    });
    expect(await snapshot()).toEqual(before);
    let expiredAfterCache = false;
    const cut = beforeRead(
      resultStagedD1(db).db,
      /SELECT command_name, result_json FROM idempotency_records/,
      async () => {
        await naturalDelay(credential, false);
        expiredAfterCache = true;
      },
      true,
    );
    expect(await execute(value(privateTaskId), authority, key, cut.db)).toEqual({
      ok: false,
      error: DENIED,
    });
    expect(cut.fired()).toBe(true);
    expect(expiredAfterCache).toBe(true);
    expect((await credentialClock(credential)).live).toBe(0);
    expect(await snapshot()).toEqual(before);
  }, 15_000);
  it("retains a valid committed checkpoint and Hub receipt when metadata expires before final public delivery", async () => {
    const { authority, credential } = await naturalOauth("+3 seconds");
    const before = await snapshot();
    let liveAtBatch = false,
      expiredAfterCommit = false;
    let committed: Record<string, unknown> | undefined;
    let observed!: ReturnType<typeof observeCheckpointWrites>;
    const staged = resultStagedD1(db, async () => {
      expect(observed.guarded()).toBe(true);
      expect((await credentialClock(credential)).live).toBe(1);
      liveAtBatch = true;
    });
    observed = observeCheckpointWrites(staged.db);
    const completed: SqlDatabase = {
      prepare: (sql) => observed.db.prepare(sql),
      withTransaction: async (work) => {
        const result = await observed.db.withTransaction(work);
        // The original production adapter's atomic batch has committed before this delay.
        committed = await snapshot();
        await naturalDelay(credential, false);
        expiredAfterCommit = true;
        return result;
      },
    };
    const input = value(privateTaskId);
    const outcome = await execute(input, authority, randomUlid(), completed);
    const receipt = success(outcome);
    expect(outcome).toMatchObject({ replayed: false });
    expect(liveAtBatch).toBe(true);
    expect(expiredAfterCommit).toBe(true);
    expect(
      await expectCheckpointCommit(before, receipt, observed.observedAt(), credential),
    ).toEqual(committed);
    await expect(
      finalizePublicBusinessResult(
        reportPrivateProgressCommand,
        withPublicBusinessAuthority(reportPrivateProgressCommand, input, authority),
        receipt,
        {
          db,
          workspaceId: FIX.workspace,
          actorHumanId: FIX.member,
          actorDelegationId: credential.id,
          authorizationEpoch: 1,
          now: new Date().toISOString(),
          cursorBase: 0,
        },
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(readPrivateProgress(db, authority, privateTaskId)).rejects.toMatchObject(DENIED);
    expect((await readPrivateProgress(db, member, privateTaskId)).checkpoints[0]?.id).toBe(
      receipt.checkpoint_id,
    );
    expect((await credentialClock(credential)).live).toBe(0);
    expect(await snapshot()).toEqual(committed);
  }, 15_000);
});
