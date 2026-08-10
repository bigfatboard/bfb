// ABOUTME: Runs repository verification commands with inherited, untruncated output.
// ABOUTME: Converts non-zero exits and missing executables into actionable failures.

import { spawn } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<void> {
  console.log("$ " + [command, ...args].join(" "));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          command +
            " failed" +
            (code === null ? " after signal " + String(signal) : " with exit code " + code),
        ),
      );
    });
  });
}
