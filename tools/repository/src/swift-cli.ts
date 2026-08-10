// ABOUTME: Builds and tests the pinned unsigned BFB macOS Xcode target.
// ABOUTME: Selects Xcode per command without changing the machine's global developer directory.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runCommand } from "./commands.js";

if (process.platform !== "darwin") {
  console.log("Swift/Xcode checks: not applicable on " + process.platform);
} else {
  const execFileAsync = promisify(execFile);
  const expectedVersion = (await readFile(".xcode-version", "utf8")).trim();
  const candidates = [
    process.env.DEVELOPER_DIR,
    "/Applications/Xcode_" + expectedVersion + ".app/Contents/Developer",
    "/Applications/Xcode.app/Contents/Developer",
  ].filter((candidate): candidate is string => candidate !== undefined);
  let developerDirectory: string | undefined;

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync("xcodebuild", ["-version"], {
        env: { ...process.env, DEVELOPER_DIR: candidate },
      });
      if (stdout.split(/\r?\n/u)[0] === "Xcode " + expectedVersion) {
        developerDirectory = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  if (developerDirectory === undefined) {
    throw new Error(
      "Xcode " + expectedVersion + " is required; no matching installation was found",
    );
  }

  const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };
  const derivedData = await mkdtemp(path.join(tmpdir(), "bfb-derived-data-"));
  const commonArguments = [
    "-project",
    "apps/macos/BFB.xcodeproj",
    "-scheme",
    "BFB",
    "-destination",
    "platform=macOS",
    "-derivedDataPath",
    derivedData,
    "CODE_SIGNING_ALLOWED=NO",
  ];

  try {
    await runCommand(
      "xcrun",
      ["swift-format", "lint", "--strict", "--recursive", "apps/macos/Sources", "apps/macos/Tests"],
      { env: environment },
    );
    await runCommand("xcodebuild", [...commonArguments, "build"], { env: environment });
    await runCommand("xcodebuild", [...commonArguments, "test"], { env: environment });
  } finally {
    await rm(derivedData, { recursive: true });
  }
  console.log("Swift/Xcode checks: passed (Xcode " + expectedVersion + ")");
}
