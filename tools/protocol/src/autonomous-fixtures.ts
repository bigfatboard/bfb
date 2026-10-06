// ABOUTME: Generates bounded synthetic Claude permission-profile fixtures for both wire codecs.
// ABOUTME: Preserves manual shapes and records old-reader rejection of the prerelease enum extension.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";

export function legacyAutonomyReader(
  directory: URL,
): (document: string, value: unknown) => boolean {
  const legacy = new Ajv2020({ strict: true });
  const addFormats = formatsModule as unknown as (typeof import("ajv-formats"))["default"];
  addFormats(legacy);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    const source = readFileSync(new URL(filename, directory), "utf8");
    // Only the two ADR 0013 additions differ from the prior closed schemas.
    const schema = JSON.parse(
      source.replace(/,\s*"(?:full_access|filesystem\.full_access)"/gu, ""),
    ) as { $id: string };
    legacy.addSchema(schema, filename);
  }
  return (document, value) => legacy.getSchema(document + ".json")!(value) === true;
}

export async function generateAutonomousFixtures(root: string): Promise<void> {
  const directory = path.join(root, "protocol/fixtures/v1");
  const specification = JSON.parse(
    await readFile(path.join(directory, "valid/launch-specification.interactive.json"), "utf8"),
  );
  specification.execution_config.provider = "claude";
  specification.execution_config.model = "sonnet";
  const inventory = JSON.parse(
    await readFile(path.join(directory, "valid/runner-inventory.sanitized.json"), "utf8"),
  );
  inventory.providers[0].provider = "claude";
  inventory.providers[0].version = "2.1.291";
  inventory.providers[0].capabilities = [
    "launch.interactive",
    "approval.on_request",
    "filesystem.workspace_write",
  ];
  const fixtures: Array<{
    name: string;
    document: string;
    json: string;
    accept: boolean;
    legacy_accept: boolean;
  }> = [];
  const add = (
    name: string,
    document: string,
    value: unknown,
    accept: boolean,
    legacyAccept: boolean,
  ) =>
    fixtures.push({
      name,
      document,
      json: JSON.stringify(value),
      accept,
      legacy_accept: legacyAccept,
    });
  add("manual.launch", "launch-specification", specification, true, true);
  add("manual.inventory", "runner-inventory", inventory, true, true);
  specification.execution_config.approval_policy = "never";
  specification.execution_config.filesystem_policy = "full_access";
  specification.execution_config.required_capabilities.push(
    "approval.never",
    "filesystem.full_access",
  );
  inventory.providers[0].capabilities.push("approval.never", "filesystem.full_access");
  add("autonomous.launch", "launch-specification", specification, true, false);
  add("autonomous.inventory", "runner-inventory", inventory, true, false);
  specification.execution_config.filesystem_policy = "danger-full-access";
  add("unknown.filesystem", "launch-specification", specification, false, false);
  inventory.providers[0].capabilities.push("filesystem.unrestricted");
  add("unknown.capability", "runner-inventory", inventory, false, false);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "claude-autonomy.json"),
    JSON.stringify(
      { owner_command: "pnpm protocol:generate", schema_version: 1, fixtures },
      null,
      2,
    ) + "\n",
  );
}
