// ABOUTME: Exercises CLI device approval, single credential exchange, and revocation.
// ABOUTME: Synthetic codes prove binding authority, epoch fencing, and hash-only storage.

import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import {
  authorizeDeviceCommand,
  CLI_CLIENT_ID,
  CLI_KEY_PREFIX,
  CLI_SCOPES,
  cliHash,
  CLI_EXCHANGE_ISSUER_ID,
  exchangeCredentialCommand,
  mintCliKey,
  resolveCliPrincipal,
  revokeBindingCommand,
  type CliBindingSummary,
} from "../src/cli-credentials.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-09-11T20:00:00.000Z";
const EXPIRES = "2026-09-11T20:10:00.000Z";
const PAST = "2026-09-11T19:50:00.000Z";
const AUTH_USER = "c05-auth-user";
const OTHER_AUTH_USER = "c05-other-auth-user";

function result<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  for (const [userId, humanId, email] of [
    [AUTH_USER, FIX.owner, "c05-owner@synthetic.test"],
    [OTHER_AUTH_USER, FIX.member, "c05-member@synthetic.test"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(userId, email, email, NOW, NOW);
    await db.prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`).run(userId, humanId);
  }
  let counter = 0;
  async function device(
    values: {
      userId?: string | null;
      status?: string;
      expiresAt?: string;
      clientId?: string | null;
    } = {},
  ) {
    counter += 1;
    const row = {
      id: `c05-device-${counter}`,
      device_code: `c05-device-code-${counter}`,
      user_code: `C05U${counter}SER`,
      user_id: values.userId === undefined ? AUTH_USER : values.userId,
      expires_at: values.expiresAt ?? EXPIRES,
      status: values.status ?? "pending",
      client_id: values.clientId === undefined ? CLI_CLIENT_ID : values.clientId,
    };
    await db
      .prepare(
        `INSERT INTO better_auth_device_codes
         (id, device_code, user_code, user_id, expires_at, status, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.device_code,
        row.user_code,
        row.user_id,
        row.expires_at,
        row.status,
        row.client_id,
      );
    return row;
  }
  function human<T, R>(
    command: HubCommand<T, R>,
    input: T,
    humanId = FIX.owner,
    now = NOW,
    workspace = FIX.workspace,
  ) {
    return hub.execute(command, {
      workspaceId: workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input,
      now,
    });
  }
  function exchange(input: Parameters<typeof exchangeCredentialCommand.run>[0], now = NOW) {
    return hub.execute(exchangeCredentialCommand, {
      workspaceId: FIX.workspace,
      actorSystemId: CLI_EXCHANGE_ISSUER_ID,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input,
      now,
    });
  }
  async function authorize(
    userCode: string,
    projectIds: string[] = [],
    humanId = FIX.owner,
  ): Promise<CliBindingSummary> {
    return result(await human(authorizeDeviceCommand, { userCode, projectIds }, humanId));
  }
  async function approve(userCode: string): Promise<void> {
    await db
      .prepare(`UPDATE better_auth_device_codes SET status = 'approved' WHERE user_code = ?`)
      .run(userCode);
  }
  return { db, hub, human, exchange, authorize, approve, device };
}

describe("CLI device authorization", () => {
  it("creates a pending binding with fixed scopes, epoch, and projects before any key exists", async () => {
    const f = await fixture();
    const row = await f.device();
    const created = await f.authorize(row.user_code, [FIX.projectA]);
    expect(created.status).toBe("pending");
    expect(created.key_prefix).toBeNull();
    expect(created.scopes).toEqual([...CLI_SCOPES]);
    expect(created.project_ids).toEqual([FIX.projectA]);
    expect(created.authorization_epoch).toBe(1);
    expect(created.human_id).toBe(FIX.owner);
  });

  it("rejects unknown, expired, approved, denied, foreign-client, and foreign-user codes", async () => {
    const f = await fixture();
    expect(
      (await f.human(authorizeDeviceCommand, { userCode: "C05-MISSING", projectIds: [] })).ok,
    ).toBe(false);
    for (const seed of [
      await f.device({ expiresAt: PAST }),
      await f.device({ status: "approved" }),
      await f.device({ status: "denied" }),
      await f.device({ clientId: "other-client" }),
      await f.device({ userId: "someone-else" }),
      await f.device({ userId: null }),
    ]) {
      const outcome = await f.human(authorizeDeviceCommand, {
        userCode: seed.user_code,
        projectIds: [],
      });
      expect(outcome.ok, seed.user_code).toBe(false);
    }
  });

  it("rejects reviewer approval, ungranted projects, and duplicate approvals", async () => {
    const f = await fixture();
    const reviewer = await f.device();
    expect(
      (
        await f.human(
          authorizeDeviceCommand,
          { userCode: reviewer.user_code, projectIds: [] },
          FIX.restricted,
        )
      ).ok,
    ).toBe(false);
    const scoped = await f.device();
    expect(
      (
        await f.human(
          authorizeDeviceCommand,
          { userCode: scoped.user_code, projectIds: [FIX.projectB] },
          FIX.restricted,
        )
      ).ok,
    ).toBe(false);
    const once = await f.device();
    await f.authorize(once.user_code);
    expect(
      (await f.human(authorizeDeviceCommand, { userCode: once.user_code, projectIds: [] })).ok,
    ).toBe(false);
  });

  it("exchanges one approved bootstrap credential for a hashed key and deletes the device row", async () => {
    const f = await fixture();
    const row = await f.device();
    await f.authorize(row.user_code);
    await f.approve(row.user_code);
    const minted = mintCliKey();
    expect(minted.key).toMatch(/^bfb_cli_[A-Za-z0-9_-]{43}$/);
    expect(minted.keyPrefix).toBe(minted.key.slice(0, 12));
    const exchanged = result(
      await f.exchange({
        deviceCode: row.device_code,
        clientId: CLI_CLIENT_ID,
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
      }),
    );
    expect(exchanged.key_prefix).toBe(minted.keyPrefix);
    expect(exchanged.scopes).toEqual([...CLI_SCOPES]);
    const stored = (await f.db
      .prepare(`SELECT key_hash, device_code_hash FROM api_key_bindings WHERE id = ?`)
      .get(exchanged.binding_id)) as { key_hash: string; device_code_hash: string };
    expect(stored.key_hash).toBe(minted.keyHash);
    expect(stored.key_hash).not.toContain(minted.key);
    expect(stored.device_code_hash).toBe(cliHash(row.device_code));
    expect(
      await f.db.prepare(`SELECT id FROM better_auth_device_codes WHERE id = ?`).get(row.id),
    ).toBeUndefined();
    const principal = await resolveCliPrincipal(f.db, minted.key, NOW);
    expect(principal.bindingId).toBe(exchanged.binding_id);
    expect(principal.humanId).toBe(FIX.owner);
  });

  it("rejects double exchange, wrong client, unknown codes, and human-actor exchanges", async () => {
    const f = await fixture();
    const row = await f.device();
    await f.authorize(row.user_code);
    await f.approve(row.user_code);
    const first = mintCliKey();
    result(
      await f.exchange({
        deviceCode: row.device_code,
        clientId: CLI_CLIENT_ID,
        keyHash: first.keyHash,
        keyPrefix: first.keyPrefix,
      }),
    );
    const second = mintCliKey();
    expect(
      (
        await f.exchange({
          deviceCode: row.device_code,
          clientId: CLI_CLIENT_ID,
          keyHash: second.keyHash,
          keyPrefix: second.keyPrefix,
        })
      ).ok,
    ).toBe(false);
    const pending = await f.device();
    await f.authorize(pending.user_code);
    await f.approve(pending.user_code);
    const other = mintCliKey();
    expect(
      (
        await f.exchange({
          deviceCode: pending.device_code,
          clientId: "other-client",
          keyHash: other.keyHash,
          keyPrefix: other.keyPrefix,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.exchange({
          deviceCode: "c05-unknown-device-code",
          clientId: CLI_CLIENT_ID,
          keyHash: other.keyHash,
          keyPrefix: other.keyPrefix,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.hub.execute(exchangeCredentialCommand, {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          input: {
            deviceCode: pending.device_code,
            clientId: CLI_CLIENT_ID,
            keyHash: other.keyHash,
            keyPrefix: other.keyPrefix,
          },
          now: NOW,
        })
      ).ok,
    ).toBe(false);
  });

  it("revokes before cleanup and disables exchange plus per-request authority", async () => {
    const f = await fixture();
    const row = await f.device();
    const created = await f.authorize(row.user_code);
    const revoked = result(await f.human(revokeBindingCommand, { bindingId: created.binding_id }));
    expect(revoked.status).toBe("revoked");
    expect(revoked.revoked_at).toBe(NOW);
    expect(
      await f.db.prepare(`SELECT id FROM better_auth_device_codes WHERE id = ?`).get(row.id),
    ).toBeUndefined();
    const minted = mintCliKey();
    expect(
      (
        await f.exchange({
          deviceCode: row.device_code,
          clientId: CLI_CLIENT_ID,
          keyHash: minted.keyHash,
          keyPrefix: minted.keyPrefix,
        })
      ).ok,
    ).toBe(false);
    const live = await f.device();
    await f.authorize(live.user_code);
    await f.approve(live.user_code);
    const key = mintCliKey();
    result(
      await f.exchange({
        deviceCode: live.device_code,
        clientId: CLI_CLIENT_ID,
        keyHash: key.keyHash,
        keyPrefix: key.keyPrefix,
      }),
    );
    await f.human(revokeBindingCommand, {
      bindingId: (
        (await f.db
          .prepare(`SELECT id FROM api_key_bindings WHERE key_hash = ?`)
          .get(key.keyHash)) as { id: string }
      ).id,
    });
    await expect(resolveCliPrincipal(f.db, key.key, NOW)).rejects.toThrow();
  });

  it("rejects foreign revocation and joins current membership plus epoch on every request", async () => {
    const f = await fixture();
    const row = await f.device();
    const created = await f.authorize(row.user_code);
    expect(
      (await f.human(revokeBindingCommand, { bindingId: created.binding_id }, FIX.member)).ok,
    ).toBe(false);
    const live = await f.device();
    await f.authorize(live.user_code, [FIX.projectA]);
    await f.approve(live.user_code);
    const key = mintCliKey();
    result(
      await f.exchange({
        deviceCode: live.device_code,
        clientId: CLI_CLIENT_ID,
        keyHash: key.keyHash,
        keyPrefix: key.keyPrefix,
      }),
    );
    expect((await resolveCliPrincipal(f.db, key.key, NOW)).projectIds).toEqual([FIX.projectA]);
    await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
    await expect(resolveCliPrincipal(f.db, key.key, NOW)).rejects.toThrow();
  });

  it("rejects expired, unexchanged, malformed, and unknown credentials without oracle detail", async () => {
    const f = await fixture();
    const row = await f.device();
    await f.authorize(row.user_code);
    await f.approve(row.user_code);
    const key = mintCliKey();
    result(
      await f.exchange({
        deviceCode: row.device_code,
        clientId: CLI_CLIENT_ID,
        keyHash: key.keyHash,
        keyPrefix: key.keyPrefix,
      }),
    );
    await expect(
      resolveCliPrincipal(f.db, key.key, "2026-12-11T20:00:00.000Z"),
    ).rejects.toMatchObject({
      code: "unauthenticated",
    });
    const pending = await f.device();
    await f.authorize(pending.user_code);
    const unexchanged = mintCliKey();
    await expect(resolveCliPrincipal(f.db, unexchanged.key, NOW)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    for (const candidate of [
      "not-a-key",
      "bfb_cli_short",
      `bfb_cli_${"x".repeat(43)}`,
      `mcp_${"y".repeat(43)}`,
    ]) {
      await expect(resolveCliPrincipal(f.db, candidate, NOW)).rejects.toMatchObject({
        code: "unauthenticated",
      });
    }
  });

  it("keeps raw keys and bootstrap codes out of persisted command history", async () => {
    const f = await fixture();
    const row = await f.device();
    await f.authorize(row.user_code);
    await f.approve(row.user_code);
    const key = mintCliKey();
    result(
      await f.exchange({
        deviceCode: row.device_code,
        clientId: CLI_CLIENT_ID,
        keyHash: key.keyHash,
        keyPrefix: key.keyPrefix,
      }),
    );
    const dump = JSON.stringify({
      bindings: await f.db.prepare(`SELECT * FROM api_key_bindings`).all(),
      events: await f.db.prepare(`SELECT payload_json FROM semantic_events`).all(),
      audit: await f.db.prepare(`SELECT payload_json FROM audit_events`).all(),
      idempotency: await f.db.prepare(`SELECT result_json FROM idempotency_records`).all(),
    });
    for (const secret of [key.key, row.device_code, row.user_code]) {
      expect(dump.includes(secret)).toBe(false);
    }
    expect(dump.includes(key.keyHash)).toBe(true);
    expect(dump.includes(CLI_KEY_PREFIX)).toBe(true);
  });
});
