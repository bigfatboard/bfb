// ABOUTME: Mounts the production ArtifactViewer for synthetic browser-auth runtime acceptance.
// ABOUTME: Real fixture API responses drive grant issuance, reload, stop and denial states.

import { createRoot } from "react-dom/client";
import { ArtifactViewer, type ArtifactViewerProps } from "../../src/artifacts/ArtifactViewer.js";

const fixture = window as unknown as { __v02Props: ArtifactViewerProps };
const root = document.getElementById("root");
if (!root) throw new Error("Synthetic viewer root is missing.");
createRoot(root).render(<ArtifactViewer {...fixture.__v02Props} />);
