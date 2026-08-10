// ABOUTME: Runs the source-header policy check from the repository command surface.
// ABOUTME: Prints every offending path before returning a non-zero status.

import { validateAboutmeHeaders } from "./aboutme.js";

const failures = await validateAboutmeHeaders(process.cwd());
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("ABOUTME headers: passed");
}
