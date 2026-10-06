// ABOUTME: Generates deterministic root-only lease observations and cross-language rejection fixtures.
// ABOUTME: Proves family uncertainty cannot be downgraded to strict containment or release evidence.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function generateRootLeaseFixtures(root: string): Promise<void> {
  const live = {
    schema_version: 2,
    run_execution_id: "01K6R7DT00AAAAAAAAAAAAAAAA",
    assignment_generation: 7,
    fencing_generation: 9,
    sequence: 1,
    observed_at: "2026-10-06T00:00:00.000Z",
    operation: "renew",
    supervisor: {
      pid: 1234,
      start_identity: "123456:1000",
      executable_hash: `sha256:${"a".repeat(64)}`,
    },
    local_lock_id: "01K6R7DT00BBBBBBBBBBBBBBBB",
    owned_group_id: 1235,
    owned_group_start_identity: "123456:2000",
    supervisor_state: "verified",
    group_state: "live",
    lock_state: "held",
    descendants_state: "unproven",
    recovery_local: false,
    supervision_mode: "root",
    family_coverage: "unproven",
  };
  const fixtures: Array<{
    name: string;
    document: string;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
  }> = [];
  const add = (
    name: string,
    value: unknown,
    accept: boolean,
    document = "checkout-root-lease-observation",
  ) => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    const canonical = JSON.stringify(value, (_key, nested: unknown) =>
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(
            Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : nested,
    );
    fixtures.push({
      name,
      document,
      json,
      accept,
      ...(accept ? { canonical_sha256: createHash("sha256").update(canonical).digest("hex") } : {}),
    });
  };
  add("renew", live, true);
  add("root-gone", { ...live, sequence: 2, operation: "unknown", group_state: "gone" }, true);
  const unstarted = Object.fromEntries(
    Object.entries(live).filter(([key]) => key !== "supervisor"),
  );
  add(
    "unstarted-unknown",
    {
      ...unstarted,
      operation: "unknown",
      owned_group_id: 0,
      owned_group_start_identity: "",
      supervisor_state: "never_started",
      group_state: "never_started",
      lock_state: "never_acquired",
    },
    true,
  );
  for (const operation of ["release", "recover"]) add(operation, { ...live, operation }, false);
  for (const descendants_state of ["contained", "gone", "none", "escaped", "unknown"])
    add("descendants." + descendants_state, { ...live, descendants_state }, false);
  add("wrong-mode", { ...live, supervision_mode: "strict" }, false);
  add("proven-family", { ...live, family_coverage: "proven" }, false);
  add("operator-acknowledgement", { ...live, recovery_local: true }, false);
  add(
    "missing-mode",
    Object.fromEntries(Object.entries(live).filter(([key]) => key !== "supervision_mode")),
    false,
  );
  add(
    "missing-coverage",
    Object.fromEntries(Object.entries(live).filter(([key]) => key !== "family_coverage")),
    false,
  );
  add("private-path", { ...live, cwd: "/synthetic/private" }, false);
  add("shell", { ...live, argv: ["synthetic"] }, false);
  add("v1", { ...live, schema_version: 1 }, false);
  add("future-version", { ...live, schema_version: 3 }, false);
  add(
    "fractional-version",
    JSON.stringify(live).replace('"schema_version":2', '"schema_version":2.0000000000000001'),
    false,
  );
  add(
    "duplicate-version",
    JSON.stringify(live).replace('"schema_version":2', '"schema_version":2,"schema_version":2'),
    false,
  );
  add("strict-reader", live, false, "checkout-lease-observation");
  add("strict-downgrade", { ...live, schema_version: 1 }, false, "checkout-lease-observation");
  const directory = path.join(root, "protocol/fixtures/v2");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "checkout-root-lease-observation.json"),
    JSON.stringify(
      {
        owner_command: "pnpm protocol:generate",
        document: "checkout-root-lease-observation",
        schema_version: 2,
        fixtures,
      },
      null,
      2,
    ) + "\n",
  );
}
