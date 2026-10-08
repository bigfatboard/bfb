// ABOUTME: Defines private persistent pilot paths and validates operator-owned inputs.
// ABOUTME: Keeps credentials out of diagnostics and fixes the real Worker origins and bindings.

import { constants, realpathSync } from "node:fs";
import { mkdir, open, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const origins = {
  app: "https://localhost:8787",
  artifact: "https://artifacts.localhost:8788",
  launch: "https://launch.localhost:8787",
};
export const controlSecrets = [
  "BETTER_AUTH_SECRETS",
  "AUTH_ABUSE_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
];
export const artifactSecrets = ["UPLOAD_ABUSE_SECRET"];

function requirePhysicalPilotPath(path) {
  let ancestor = path;
  const suffix = [];
  let physical;
  for (;;) {
    try {
      physical = join(realpathSync(ancestor), ...suffix);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const fromRepository = relative(realpathSync(repoRoot), physical);
  if (
    !fromRepository ||
    (fromRepository !== ".." && !fromRepository.startsWith("../") && !isAbsolute(fromRepository))
  ) {
    throw new Error("Pilot credentials and persistent state must stay outside the repository.");
  }
  if (physical !== path) {
    throw new Error(
      "Pilot paths must be physical canonical paths without symlink ancestors; nothing rewritten.",
    );
  }
}

export function pilotPaths(root = process.env.BFB_PILOT_STATE_DIR) {
  root ??= join(homedir(), "Library/Application Support/BFB Pilot");
  if (!isAbsolute(root) || resolve(root) !== root || root === "/" || root === homedir()) {
    throw new Error("Pilot state must be a dedicated canonical absolute directory.");
  }
  requirePhysicalPilotPath(root);
  return {
    root,
    data: join(root, "data"),
    logs: join(root, "logs"),
    runtime: join(root, "runtime.json"),
    socket: join(root, "supervisor.sock"),
    controlEnv: join(root, "control.env"),
    artifactEnv: join(root, "artifact.env"),
    certificate: join(root, "tls/server.pem"),
    certificateKey: join(root, "tls/server-key.pem"),
    bootstrapCode: join(root, "bootstrap-code.txt"),
  };
}

export async function privateDirectory(path) {
  requirePhysicalPilotPath(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o077
  ) {
    throw new Error("Pilot directory must be owned by this user and private (0700).");
  }
}

export async function privateFile(path) {
  requirePhysicalPilotPath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077 ||
      info.size > 16_384
    ) {
      throw new Error("Pilot input must be an owned private regular file (0600), at most 16 KiB.");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function readSecrets(path, names) {
  const values = parseEnv(await privateFile(path));
  if (Object.keys(values).some((name) => !names.includes(name))) {
    throw new Error(
      "Pilot secret file contains an undeclared binding; origins and features are fixed.",
    );
  }
  return values;
}

export function secretChecks(values, names) {
  return names.map((name) => ({
    name,
    present: typeof values[name] === "string" && values[name].length > 0,
  }));
}

export function validateSecrets(control, artifact) {
  const missing = [
    ...secretChecks(control, controlSecrets),
    ...secretChecks(artifact, artifactSecrets),
  ]
    .filter((check) => !check.present)
    .map((check) => check.name);
  if (missing.length) throw new Error(`Missing pilot bindings: ${missing.join(", ")}`);
  if (control.AUTH_ABUSE_SECRET.length < 32 || artifact.UPLOAD_ABUSE_SECRET.length < 32) {
    throw new Error("Pilot abuse keys must contain at least 32 characters.");
  }
  const entries = control.BETTER_AUTH_SECRETS.split(",").map((entry) => entry.trim());
  if (
    entries.length < 1 ||
    entries.length > 2 ||
    entries.some((entry) => !/^(0|[1-9][0-9]*):.{32,}$/u.test(entry))
  ) {
    throw new Error(
      "BETTER_AUTH_SECRETS needs one current and optionally one previous versioned key.",
    );
  }
  const versions = entries.map((entry) => Number(entry.slice(0, entry.indexOf(":"))));
  if (
    versions.some((version) => !Number.isSafeInteger(version)) ||
    new Set(versions).size !== versions.length
  ) {
    throw new Error("BETTER_AUTH_SECRETS versions must be distinct safe integers.");
  }
}

export function workerArguments(worker, paths) {
  if (worker !== "control" && worker !== "artifact") throw new Error("Unknown pilot Worker.");
  const app = worker === "control" ? "control-worker" : "artifact-worker";
  return [
    "dev",
    "--local",
    "--config",
    join(repoRoot, `apps/${app}/wrangler.pilot.toml`),
    "--env-file",
    worker === "control" ? paths.controlEnv : paths.artifactEnv,
    "--persist-to",
    paths.data,
    "--local-protocol",
    "https",
    "--https-cert-path",
    paths.certificate,
    "--https-key-path",
    paths.certificateKey,
    "--show-interactive-dev-session=false",
  ];
}

export function wranglerEnvironment(logPath) {
  const environment = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
  return {
    ...environment,
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: logPath,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  };
}

export async function assertPinnedWrangler() {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "apps/control-worker/package.json"), "utf8"),
  );
  if (manifest.devDependencies.wrangler !== "4.120.1")
    throw new Error("Pilot Wrangler version changed.");
  return join(repoRoot, "apps/control-worker/node_modules/.bin/wrangler");
}
