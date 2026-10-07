// ABOUTME: Proves the opt-in public command adapter preserves original hooks and internal branch semantics.
// ABOUTME: Retained authority stays out of business identity, audits and results while late guards roll back effects.

import { describe, expect, it } from "vitest";
import { loadPrincipal } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  publicBusinessCommand,
  publicBusinessSelection,
  publicMemberAuthorityPredicate,
  withPublicBusinessAuthority,
  ownsPublicBusinessDelivery,
  type PublicBusinessAuthority,
} from "../src/public-business.js";
import { openDomainDb } from "./helpers.js";
import { resultStagedD1 } from "./result-fixture.js";

interface Input {
  label: string;
  internal?: boolean;
}
interface Result {
  label: string;
  observedAt: string;
}

async function fixture(
  options: {
    authorize?: boolean;
    oneUse?: boolean;
    fallbackAudit?: boolean;
    internal?: boolean;
  } = {},
) {
  const db = await openDomainDb(),
    calls: Record<string, unknown[]> = {
      authorize: [],
      run: [],
      fingerprint: [],
      audit: [],
      extra: [],
      replay: [],
    };
  const base: HubCommand<Input, Result> = {
    name: "synthetic.public-business",
    ...(options.authorize === false
      ? {}
      : {
          authorize: async (input: Input) => {
            calls.authorize!.push(input);
          },
        }),
    ...(options.oneUse ? { replay: "reject" as const } : {}),
    inputFingerprint(input) {
      calls.fingerprint!.push(input);
      return JSON.stringify(input);
    },
    ...(options.fallbackAudit
      ? {}
      : {
          auditInput: (input: Input) => {
            calls.audit!.push(input);
            return input;
          },
        }),
    extraCursors(input) {
      calls.extra!.push(input);
      return 0;
    },
    async replayResult(result, _ctx, input) {
      calls.replay!.push(input);
      return result;
    },
    async run(input, ctx) {
      calls.run!.push(input);
      await ctx.db
        .prepare("UPDATE humans SET display_name=? WHERE id=?")
        .run(input.label, FIX.owner);
      return { label: input.label, observedAt: ctx.now };
    },
  };
  const command = publicBusinessCommand(base, {
    applies: (input) => !(options.internal && input.internal),
    admission: (_input, authority) => publicMemberAuthorityPredicate(authority, ["owner"]),
    delivery: (_input, _result, authority) =>
      publicBusinessSelection(publicMemberAuthorityPredicate(authority, ["owner"])),
  });
  const authority = await loadPrincipal(db, FIX.workspace, FIX.owner);
  const request = {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    idempotencyKey: randomUlid(),
    now: "2025-01-01T00:00:00.000Z",
    input: withPublicBusinessAuthority(command, { label: "Synthetic adapter name" }, authority),
  };
  return { db, command, calls, authority, request, hub: new WorkspaceHub(db) };
}

describe("public business adapter mechanics", () => {
  it.each([false, true])(
    "strips every base hook and audit fallback=%s without changing retry identity",
    async (fallbackAudit) => {
      const f = await fixture({ fallbackAudit }),
        original = await f.hub.execute(f.command, f.request);
      expect(original.ok).toBe(true);
      const history = await f.db
        .prepare("SELECT * FROM idempotency_records WHERE idempotency_key=?")
        .get(f.request.idempotencyKey);
      const replay = await f.hub.execute(f.command, {
        ...f.request,
        input: withPublicBusinessAuthority(
          f.command,
          { label: "Synthetic adapter name" },
          { ...f.authority, projectIds: [...f.authority.projectIds].reverse() },
        ),
      });
      expect(replay).toEqual({ ...original, replayed: true });
      expect(
        await f.db
          .prepare("SELECT * FROM idempotency_records WHERE idempotency_key=?")
          .get(f.request.idempotencyKey),
      ).toEqual(history);
      expect(JSON.stringify(f.calls)).not.toContain("publicAuthority");
      for (const table of [
        "audit_events",
        "semantic_events",
        "outbox_records",
        "idempotency_records",
      ])
        expect(JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(
          "publicAuthority",
        );
    },
  );

  it("keeps a missing authorizer and the caller observation clock", async () => {
    const f = await fixture({ authorize: false, oneUse: true });
    expect(f.command.authorize).toBeUndefined();
    const original = await f.hub.execute(f.command, f.request);
    expect(original).toMatchObject({ ok: true, result: { observedAt: f.request.now } });
    expect(await f.hub.execute(f.command, f.request)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
  });

  it("rejects privilege gained after the captured role rather than adopting it", async () => {
    const f = await fixture();
    const input = withPublicBusinessAuthority(
      f.command,
      { label: "Synthetic denied name" },
      { ...f.authority, role: "reviewer" },
    );
    expect(await f.hub.execute(f.command, { ...f.request, input })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(f.calls.run).toEqual([]);
  });

  it.each(["cli-array-id", "delegation-array-boundary", "newline-project"])(
    "rejects malformed internal capsule %s uniformly before effects",
    async (kind) => {
      const f = await fixture();
      const authority = { ...f.authority } as PublicBusinessAuthority;
      if (kind === "newline-project") authority.projectIds = [`${FIX.projectA}\n`];
      else if (kind === "cli-array-id")
        authority.credential = {
          kind: "cli",
          bindingId: [randomUlid()] as unknown as string,
          scopes: ["bfb:task:write"],
        };
      else
        authority.credential = {
          kind: "delegation",
          delegationId: randomUlid(),
          clientId: "synthetic-client",
          projectId: [FIX.projectA] as unknown as string,
          taskId: null,
          scopes: ["bfb:task:write"],
        };
      const input = withPublicBusinessAuthority(
        f.command,
        { label: "Synthetic denied name" },
        authority,
      );
      const request = {
        ...f.request,
        input,
        ...(authority.credential?.kind === "delegation"
          ? { actorDelegationId: authority.credential.delegationId }
          : {}),
      };
      expect(await f.hub.execute(f.command, request)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(f.calls.run).toEqual([]);
    },
  );

  it("inserts a failing guard even when the final typed selector has no source rows", async () => {
    const f = await fixture();
    const command = publicBusinessCommand<Input, Result>(
      {
        name: "synthetic.no-source",
        async run(input, ctx) {
          await ctx.db
            .prepare("UPDATE humans SET display_name=? WHERE id=?")
            .run(input.label, FIX.owner);
          return { label: input.label, observedAt: ctx.now };
        },
      },
      {
        admission: () => ({ sql: "1", parameters: [] }),
        delivery: () => ({ sql: "SELECT 1 FROM projects WHERE id=?", parameters: [randomUlid()] }),
      },
    );
    const before = await f.db.prepare("SELECT display_name FROM humans WHERE id=?").get(FIX.owner);
    const request = {
      ...f.request,
      input: withPublicBusinessAuthority(
        command,
        { label: "Synthetic rolled-back name" },
        f.authority,
      ),
    };
    expect(await new WorkspaceHub(resultStagedD1(f.db).db).execute(command, request)).toMatchObject(
      { ok: false, error: { code: "command_failed" } },
    );
    expect(await f.db.prepare("SELECT display_name FROM humans WHERE id=?").get(FIX.owner)).toEqual(
      before,
    );
    expect(await f.db.prepare("SELECT * FROM artifact_mutation_guards").all()).toEqual([]);
  });

  it("fully bypasses the execution-owned union branch without capturing human authority", async () => {
    const f = await fixture({ authorize: false, internal: true }),
      input = { label: "Synthetic internal name", internal: true };
    expect(ownsPublicBusinessDelivery(f.command, input)).toBe(false);
    expect(withPublicBusinessAuthority(f.command, input, f.authority)).toBe(input);
    expect(
      await f.hub.execute(f.command, {
        ...f.request,
        actorHumanId: undefined,
        actorSystemId: FIX.owner,
        input,
      }),
    ).toMatchObject({ ok: true });
    expect(f.calls.run).toEqual([input]);
  });
});
