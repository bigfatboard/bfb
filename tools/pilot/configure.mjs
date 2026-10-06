// ABOUTME: Creates private real-auth pilot bindings without putting credentials in arguments or logs.
// ABOUTME: Reuses existing valid operator keys and accepts new GitHub credentials only through hidden input.

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactSecrets,
  controlSecrets,
  origins,
  pilotPaths,
  privateDirectory,
  readSecrets,
  validateSecrets,
} from "./state.mjs";

async function existingSecrets(path, names) {
  try {
    return { exists: true, values: await readSecrets(path, names) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, values: {} };
    throw error;
  }
}

export function secretFile(values, names) {
  return names
    .map((name) => {
      const value = values[name];
      if (typeof value !== "string" || !/^[A-Za-z0-9_:.,+/=-]+$/u.test(value)) {
        throw new Error("Pilot secret has an unsupported character; nothing was written.");
      }
      return `${name}=${value}\n`;
    })
    .join("");
}

export async function configurePilot(paths, prompt) {
  await privateDirectory(paths.root);
  const existingControl = await existingSecrets(paths.controlEnv, controlSecrets);
  const existingArtifact = await existingSecrets(paths.artifactEnv, artifactSecrets);
  const control = existingControl.exists
    ? existingControl.values
    : {
        BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64url")}`,
        AUTH_ABUSE_SECRET: randomBytes(32).toString("base64url"),
        GITHUB_CLIENT_ID: (await prompt("GitHub OAuth Client ID (input hidden): ")).trim(),
        GITHUB_CLIENT_SECRET: (await prompt("GitHub OAuth Client Secret (input hidden): ")).trim(),
      };
  const artifact = existingArtifact.exists
    ? existingArtifact.values
    : {
        UPLOAD_ABUSE_SECRET: randomBytes(32).toString("base64url"),
      };
  validateSecrets(control, artifact);
  const controlBody = existingControl.exists ? undefined : secretFile(control, controlSecrets);
  const artifactBody = existingArtifact.exists ? undefined : secretFile(artifact, artifactSecrets);
  // Preserve existing operator state, including a partial earlier publication.
  // Exclusive creation refuses concurrent configuration; retry reuses valid files.
  if (controlBody !== undefined)
    await writeFile(paths.controlEnv, controlBody, { mode: 0o600, flag: "wx" });
  if (artifactBody !== undefined)
    await writeFile(paths.artifactEnv, artifactBody, { mode: 0o600, flag: "wx" });
  return { configured: true, existing: existingControl.exists && existingArtifact.exists };
}

async function main() {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Run pilot:configure in an interactive terminal; never pass credentials as arguments.",
    );
  }
  console.log(`GitHub OAuth homepage: ${origins.app}`);
  console.log(`GitHub OAuth callback: ${origins.app}/auth/callback/github`);
  console.log("Input is hidden. Credentials stay in private local files, outside the repository.");
  const controller = new AbortController();
  // Readline still handles terminal editing; its entire echo/output stream is muted.
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  reader.on("SIGINT", () => controller.abort());
  try {
    const result = await configurePilot(pilotPaths(), async (label) => {
      process.stdout.write(label);
      const answer = await reader.question("", { signal: controller.signal });
      process.stdout.write("\n");
      return answer;
    });
    console.log(JSON.stringify(result));
  } finally {
    reader.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "Pilot credentials were not configured. Existing files are preserved; check private file permissions and supplied values.",
    );
    process.exitCode = 1;
  });
}
