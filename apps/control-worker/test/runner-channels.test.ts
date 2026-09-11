// ABOUTME: Exercises live-channel fail-closed behavior at D1, heartbeat and expiry-alarm boundaries.
// ABOUTME: Uses socket doubles for transport faults; native Workerd acceptance supplies the real authorization proof.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertCurrentRunnerPrincipal, type RunnerPrincipal, type WorkspaceHub } from "@bfb/domain";
import { RunnerChannels } from "../src/runner-channels.js";

vi.mock("@bfb/domain", async (load) => ({
  ...(await load<typeof import("@bfb/domain")>()),
  assertCurrentRunnerPrincipal: vi.fn(),
}));

const NOW = "2026-09-12T00:00:20.000Z";
const principal: RunnerPrincipal = {
  kind: "runner",
  workspaceId: "01K00000000000000000000001",
  runnerId: "01K00000000000000000000002",
  ownerHumanId: "01K00000000000000000000003",
  authorizationEpoch: 1,
  ownerAuthorizationEpoch: 1,
  grantEpoch: 1,
  tokenEpoch: 1,
  tokenId: "01K00000000000000000000004",
  keyThumbprint: `sha256:${"a".repeat(64)}`,
  projectIds: [],
  authExpiresAt: "2026-09-12T00:05:00.000Z",
};
const connectionId = "01K00000000000000000000005";

function fixture() {
  let attachment = {
    schema_version: 1,
    principal,
    connectionId,
    lastHeartbeatAt: "2026-09-12T00:00:00.000Z",
    nudgeSequence: 0,
  };
  const socket = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn((_code: number, _reason: string) => {
      socket.readyState = 2;
    }),
    deserializeAttachment: () => attachment,
    serializeAttachment: (value: typeof attachment) => {
      attachment = value;
    },
  };
  const storage = { setAlarm: vi.fn(), deleteAlarm: vi.fn() };
  const state = { getWebSockets: () => [socket], storage };
  const first = vi.fn().mockResolvedValue({ sequence: 1 });
  const statement = { bind: (..._args: unknown[]) => statement, first, all: vi.fn(), run: vi.fn() };
  const db = { prepare: vi.fn(() => statement), batch: vi.fn() };
  const execute = vi.fn().mockResolvedValue({ ok: true });
  const channels = new RunnerChannels(
    state as unknown as DurableObjectState,
    db as unknown as D1Database,
    () => ({ execute }) as unknown as WorkspaceHub,
    () => NOW,
  );
  return { channels, socket, storage, db, first, execute, attachment: () => attachment };
}

beforeEach(() => {
  vi.mocked(assertCurrentRunnerPrincipal).mockResolvedValue(principal);
});

describe("hibernating runner channel failure boundaries", () => {
  it("closes unauthorized sockets even if loading the committed revocation signal fails", async () => {
    const f = fixture();
    vi.mocked(assertCurrentRunnerPrincipal).mockRejectedValue(new Error("synthetic D1 failure"));
    f.first.mockRejectedValue(new Error("synthetic signal read failure"));
    await expect(f.channels.afterCommand()).resolves.toBeUndefined();
    expect(f.socket.close).toHaveBeenCalledWith(4403, "authorization_required");
  });

  it("does not change a committed command outcome when its advisory nudge fails", async () => {
    const f = fixture();
    f.first.mockRejectedValue(new Error("synthetic pending query failure"));
    await expect(f.channels.afterCommand()).resolves.toBeUndefined();
    expect(f.socket.close).toHaveBeenCalledWith(1011, "channel_unavailable");
  });

  it("closes every live socket if the persistent expiry alarm cannot be set", async () => {
    const f = fixture();
    f.storage.setAlarm.mockRejectedValue(new Error("synthetic storage failure"));
    await f.channels.schedule();
    expect(f.socket.close).toHaveBeenCalledWith(1011, "channel_unavailable");
  });

  it("rejects corrupt hibernation timestamps instead of silently deleting the expiry alarm", async () => {
    const f = fixture();
    f.socket.serializeAttachment({
      ...f.attachment(),
      principal: { ...principal, authExpiresAt: "invalid" },
    });
    await f.channels.schedule();
    expect(f.socket.close).toHaveBeenCalledWith(1008, "request_rejected");
    expect(f.storage.setAlarm).not.toHaveBeenCalled();
  });

  it("bounds messages, binds heartbeat identity and rechecks authorization before acknowledging", async () => {
    for (const mutation of [
      { workspace_id: connectionId },
      { connection_id: principal.runnerId },
      { kind: "runner.commands.available" },
    ]) {
      const f = fixture();
      await f.channels.message(
        f.socket as unknown as WebSocket,
        JSON.stringify({
          schema_version: 1,
          kind: "runner.channel.heartbeat",
          workspace_id: principal.workspaceId,
          runner_id: principal.runnerId,
          connection_id: connectionId,
          ...mutation,
        }),
      );
      expect(f.socket.close).toHaveBeenCalledWith(1008, "request_rejected");
      expect(f.execute).not.toHaveBeenCalled();
    }
    const f = fixture();
    await f.channels.message(f.socket as unknown as WebSocket, "x".repeat(8193));
    expect(f.execute).not.toHaveBeenCalled();
    const healthy = fixture();
    await healthy.channels.message(
      healthy.socket as unknown as WebSocket,
      JSON.stringify({
        schema_version: 1,
        kind: "runner.channel.heartbeat",
        workspace_id: principal.workspaceId,
        runner_id: principal.runnerId,
        connection_id: connectionId,
      }),
    );
    expect(healthy.execute).toHaveBeenCalledOnce();
    expect(JSON.parse(healthy.socket.send.mock.calls[0]![0] as string)).toMatchObject({
      kind: "runner.channel.alive",
      token_epoch: 1,
      server_time: NOW,
    });
    await healthy.channels.message(
      healthy.socket as unknown as WebSocket,
      JSON.stringify({
        schema_version: 1,
        kind: "runner.channel.heartbeat",
        workspace_id: principal.workspaceId,
        runner_id: principal.runnerId,
        connection_id: connectionId,
      }),
    );
    expect(healthy.socket.close).toHaveBeenCalledWith(1008, "request_rejected");
    expect(healthy.execute).toHaveBeenCalledOnce();
  });

  it("suppresses repeated nudges without deleting or acknowledging any reference", async () => {
    const f = fixture();
    await f.channels.afterCommand();
    await f.channels.afterCommand();
    expect(f.socket.send).toHaveBeenCalledOnce();
    expect(f.db.prepare.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
    expect(f.attachment().nudgeSequence).toBe(1);
  });
});
