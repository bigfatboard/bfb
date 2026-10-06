// ABOUTME: Generates a private loopback-only TLS certificate for the local BFB pilot.
// ABOUTME: Keeps user trust explicit and never disables browser or runner certificate checks.

import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmod, link, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { origins, pilotPaths, privateDirectory, privateFile } from "./state.mjs";

export async function verifyPilotCertificate(paths) {
  const certificate = new X509Certificate(await privateFile(paths.certificate));
  const key = createPrivateKey(await privateFile(paths.certificateKey));
  if (certificate.ca || !certificate.checkPrivateKey(key)) {
    throw new Error("Pilot TLS needs a matching server-only certificate and private key.");
  }
  const expectedNames = Object.values(origins)
    .map((origin) => `DNS:${new URL(origin).hostname}`)
    .sort();
  const actualNames = certificate.subjectAltName?.split(", ").sort();
  if (
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames) ||
    certificate.keyUsage?.length !== 1 ||
    certificate.keyUsage[0] !== "1.3.6.1.5.5.7.3.1"
  ) {
    throw new Error(
      "Pilot TLS must cover only the three fixed loopback names and server authentication.",
    );
  }
  for (const origin of Object.values(origins)) {
    const host = new URL(origin).hostname;
    if (certificate.checkHost(host, { subject: "never", wildcards: false }) !== host) {
      throw new Error("Pilot certificate does not cover every fixed local host.");
    }
  }
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error("Pilot TLS certificate is not currently valid.");
  }
  return { fingerprint: certificate.fingerprint256, expires: certificate.validTo };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function generatePilotCertificate(paths) {
  await privateDirectory(paths.root);
  const directory = dirname(paths.certificate);
  await privateDirectory(directory);
  if ((await exists(paths.certificate)) || (await exists(paths.certificateKey))) {
    // Existing operator material is never rotated or replaced automatically.
    return { existing: true, ...(await verifyPilotCertificate(paths)) };
  }
  const temporary = await mkdtemp(join(directory, ".generate-"));
  try {
    const config = join(temporary, "openssl.cnf");
    await writeFile(
      config,
      `[req]
prompt = no
distinguished_name = subject
x509_extensions = server
[subject]
CN = BFB local pilot
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,DNS:artifacts.localhost,DNS:launch.localhost
`,
      { mode: 0o600, flag: "wx" },
    );
    const key = join(temporary, "key.pem");
    const certificate = join(temporary, "server.pem");
    const result = spawnSync(
      "/usr/bin/openssl",
      [
        "req",
        "-new",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "90",
        "-config",
        config,
        "-keyout",
        key,
        "-out",
        certificate,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 32_768 },
    );
    if (result.status !== 0)
      throw new Error("Local TLS generation failed; no credential output retained.");
    await chmod(key, 0o600);
    await chmod(certificate, 0o600);
    await verifyPilotCertificate({ certificate, certificateKey: key });
    // Exclusive hard links cannot overwrite a concurrent operator's files.
    await link(key, paths.certificateKey);
    await link(certificate, paths.certificate);
    return { existing: false, ...(await verifyPilotCertificate(paths)) };
  } finally {
    // Only this invocation's freshly created scratch directory is removed.
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const action = process.argv[2];
  if (process.argv.length !== 3 || !["generate", "trust", "check"].includes(action)) {
    throw new Error("Usage: node tools/pilot/tls.mjs generate|trust|check");
  }
  const paths = pilotPaths();
  const metadata =
    action === "generate"
      ? await generatePilotCertificate(paths)
      : await verifyPilotCertificate(paths);
  if (action === "trust") {
    if (process.platform !== "darwin") throw new Error("Pilot trust setup requires macOS.");
    const result = spawnSync(
      "/usr/bin/security",
      [
        "add-trusted-cert",
        "-r",
        "trustRoot",
        "-p",
        "ssl",
        "-k",
        join(homedir(), "Library/Keychains/login.keychain-db"),
        paths.certificate,
      ],
      { stdio: "inherit", timeout: 60_000 },
    );
    if (result.status !== 0)
      throw new Error("User TLS trust was not completed; finish the macOS prompt and retry.");
  }
  // Public fingerprint only; the private key never reaches logs or stdout.
  console.log(JSON.stringify({ action, ...metadata }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
