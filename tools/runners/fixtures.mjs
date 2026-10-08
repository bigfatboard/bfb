// ABOUTME: Owns deterministic synthetic runner wire fixtures and the cross-language transcript vector.
// ABOUTME: Check mode detects drift without rewriting any protocol fixtures or matrix entries.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import prettierConfig from "../../prettier.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const workspace = "01K00000000000000000000001";
const runner = "01K00000000000000000000002";
const human = "01K00000000000000000000003";
const challenge = {
  schema_version: 1,
  challenge_id: "01K00000000000000000000004",
  server_nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  workspace_id: workspace,
  runner_id: runner,
  audience: "bfb-runner",
  origin: "https://bfb.synthetic.test",
  public_key_thumbprint: `sha256:${"a".repeat(64)}`,
  purpose: "token",
  authorization_epoch: 1,
  owner_authorization_epoch: 2,
  grant_epoch: 3,
  token_epoch: 0,
  token_id: null,
  request: null,
  issued_at: "2026-09-11T20:00:00.000Z",
  expires_at: "2026-09-11T20:01:00.000Z",
};
const request = {
  ...challenge,
  purpose: "request",
  token_epoch: 1,
  token_id: "01K00000000000000000000005",
  request: {
    method: "POST",
    path: `/runner/workspaces/${workspace}/runners/${runner}/authenticate`,
    body_sha256: hash(""),
  },
};
const close = {
  schema_version: 1,
  kind: "runner.channel.close",
  signal_id: "01K00000000000000000000006",
  workspace_id: workspace,
  runner_id: runner,
  authorization_epoch: 2,
  grant_epoch: 4,
  token_epoch: 1,
  reason: "revoked",
  removed_human_id: null,
  created_at: "2026-09-11T20:01:00.000Z",
};
const identity = {
  schema_version: 1,
  runner_id: runner,
  workspace_id: workspace,
  owner_human_id: human,
  device_label: "Synthetic Mac",
  public_key_thumbprint: challenge.public_key_thumbprint,
  authorization_epoch: 1,
  grant_epoch: 3,
  status: "enrolled",
  enrolled_at: challenge.issued_at,
  granted_project_ids: [],
  launcher_human_ids: [human],
};
// P-256's standard base point is public synthetic fixture material, not a secret.
const publicKey = {
  crv: "P-256",
  kty: "EC",
  x: Buffer.from(
    "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
    "hex",
  ).toString("base64url"),
  y: Buffer.from(
    "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
    "hex",
  ).toString("base64url"),
};
const localEnrollment = {
  runner_id: runner,
  workspace_id: workspace,
  app_origin: challenge.origin,
  device_label: "Synthetic Mac",
  public_key: publicKey,
  public_key_thumbprint: `sha256:${hash(JSON.stringify(publicKey))}`,
  connection_state: "pending_approval",
  token_epoch: 0,
  created_at: challenge.issued_at,
};
const handoff = {
  device_label: localEnrollment.device_label,
  public_key: publicKey,
  runner_id: runner,
  schema_version: 1,
  workspace_id: workspace,
};
const channel = {
  schema_version: 1,
  kind: "runner.channel.ready",
  workspace_id: workspace,
  runner_id: runner,
  connection_id: "01K00000000000000000000007",
  token_epoch: 1,
  server_time: challenge.issued_at,
  auth_expires_at: "2026-09-11T20:05:00.000Z",
  project_ids: [],
};
const pull = {
  schema_version: 1,
  workspace_id: workspace,
  runner_id: runner,
  more: false,
  commands: [
    {
      command_id: "01K00000000000000000000008",
      command_kind: "launch",
      expires_at: "2026-09-11T20:02:00.000Z",
    },
  ],
};
const inventory = {
  schema_version: 1,
  workspace_id: workspace,
  runner_id: runner,
  revision: 1,
  checkouts: [],
  providers: [
    {
      provider: "fake",
      version: "1.0.0",
      manifest_id: `sha256:${"b".repeat(64)}`,
      capabilities: ["launch.headless", "discussion.read_only"],
      status: "healthy",
      observed_at: challenge.issued_at,
      expires_at: "2026-09-11T20:00:30.000Z",
    },
  ],
};
const fixtures = [
  ["valid/runner-identity.private.json", "runner-identity", identity],
  ["valid/runner-challenge.token.json", "runner-challenge", challenge],
  ["valid/runner-challenge.request.json", "runner-challenge", request],
  ["valid/runner-channel-close.revoked.json", "runner-channel-close", close],
  [
    "invalid/runner-challenge.audience.json",
    "runner-challenge",
    { ...challenge, audience: "bfb-browser" },
    "type_mismatch",
  ],
  [
    "invalid/runner-challenge.request-binding.json",
    "runner-challenge",
    { ...request, request: null },
    "type_mismatch",
  ],
  [
    "invalid/runner-challenge.private-key.json",
    "runner-challenge",
    { ...challenge, private_key: "synthetic-not-a-key" },
    "additional_field",
  ],
  [
    "invalid/runner-channel-close.reason.json",
    "runner-channel-close",
    { ...close, reason: "cleanup_done" },
    "type_mismatch",
  ],
  ["valid/runner-local-enrollment.pending.json", "runner-local-enrollment", localEnrollment],
  [
    "valid/runner-local-enrollment.key-pending.json",
    "runner-local-enrollment",
    {
      ...localEnrollment,
      connection_state: "key_pending",
      public_key: null,
      public_key_thumbprint: "",
    },
  ],
  ["valid/runner-enrollment-handoff.public.json", "runner-enrollment-handoff", handoff],
  ["valid/runner-channel-message.ready.json", "runner-channel-message", channel],
  ["valid/runner-command-pull.pending.json", "runner-command-pull", pull],
  ["valid/runner-inventory.sanitized.json", "runner-inventory", inventory],
  [
    "invalid/runner-local-enrollment.private-key.json",
    "runner-local-enrollment",
    { ...localEnrollment, public_key: { ...publicKey, d: "not-a-private-key" } },
    "additional_field",
  ],
  [
    "invalid/runner-channel-message.missing-time.json",
    "runner-channel-message",
    { ...channel, server_time: undefined },
    "missing_field",
  ],
  [
    "invalid/runner-command-pull.shell.json",
    "runner-command-pull",
    { ...pull, commands: [{ ...pull.commands[0], command: "synthetic-invalid-shell" }] },
    "shell_data",
  ],
  [
    "invalid/runner-inventory.configuration.json",
    "runner-inventory",
    {
      ...inventory,
      providers: [{ ...inventory.providers[0], configuration: "synthetic-private-config" }],
    },
    "additional_field",
  ],
  [
    "invalid/runner-enrollment-handoff.private-key.json",
    "runner-enrollment-handoff",
    { ...handoff, public_key: { ...publicKey, d: "not-a-private-key" } },
    "additional_field",
  ],
];

async function output(path, value) {
  const contents = await format(JSON.stringify(value, null, 2), {
    ...prettierConfig,
    parser: "json",
  });
  if (check) assert.equal(await readFile(resolve(root, path), "utf8"), contents, `${path} drifted`);
  else await writeFile(resolve(root, path), contents);
}

for (const [path, , value] of fixtures) await output("protocol/fixtures/v1/" + path, value);
const matrixPath = "protocol/fixtures/v1/matrix.json";
const matrix = JSON.parse(await readFile(resolve(root, matrixPath), "utf8"));
const names = new Set(fixtures.map(([path]) => path));
const ownedEntries = fixtures.map(([path, schema, , category]) => ({
  path,
  schema,
  expect: category ? "reject" : "accept",
  ...(category ? { category } : {}),
}));
if (check)
  assert.deepEqual(
    matrix.fixtures.filter((entry) => names.has(entry.path)),
    ownedEntries,
  );
else
  await output(matrixPath, {
    ...matrix,
    fixtures: [...matrix.fixtures.filter((entry) => !names.has(entry.path)), ...ownedEntries],
  });

const transcript = `BFB-RUNNER-POSSESSION-V1\n${JSON.stringify([
  challenge.challenge_id,
  challenge.server_nonce,
  workspace,
  runner,
  challenge.audience,
  challenge.origin,
  challenge.public_key_thumbprint,
  challenge.purpose,
  challenge.authorization_epoch,
  challenge.owner_authorization_epoch,
  challenge.grant_epoch,
  challenge.token_epoch,
  challenge.token_id,
  null,
  challenge.issued_at,
  challenge.expires_at,
])}\n`;
await output("protocol/fixtures/runner-possession.json", {
  synthetic: true,
  challenge,
  transcript,
  transcript_sha256: hash(transcript),
});
await output("protocol/fixtures/runner-token-claims.json", {
  synthetic: true,
  format: "stateful-not-jwt",
  claims: {
    v: 1,
    sub: runner,
    workspace_id: workspace,
    aud: "bfb-runner",
    iss: challenge.origin,
    jti: request.token_id,
    iat: Math.floor(Date.parse(challenge.issued_at) / 1000),
    exp: Math.floor(Date.parse(challenge.issued_at) / 1000) + 300,
    authorization_epoch: 1,
    owner_authorization_epoch: 2,
    grant_epoch: 3,
    token_epoch: 1,
    cnf: { jkt: challenge.public_key_thumbprint },
  },
});
console.log(check ? "Runner fixtures: clean" : "Runner fixtures: generated");
