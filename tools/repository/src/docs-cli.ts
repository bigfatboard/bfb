// ABOUTME: Runs the Markdown link check from the repository command surface.
// ABOUTME: Reports each missing local target with its source document and line.

import { validateMarkdownLinks } from "./docs.js";

const failures = await validateMarkdownLinks(process.cwd());
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      failure.document + ":" + failure.line + " points to missing local target " + failure.target,
    );
  }
  process.exitCode = 1;
} else {
  console.log("Markdown links: passed");
}
