// ABOUTME: Runs the production Artifact Worker on a disposable native-fixture D1 and R2 origin.
// ABOUTME: Uses the current server clock and does not replace upload authorization or grant validation.

import { createArtifactFetchHandler } from "../../apps/artifact-worker/src/index.js";

export default { fetch: createArtifactFetchHandler() };
