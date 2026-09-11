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
