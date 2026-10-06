// ABOUTME: Mounts production artifact viewing and review for synthetic browser-auth acceptance.
// ABOUTME: Real fixture API responses drive preview, review, reload, timer and denial states.

import { createRoot } from "react-dom/client";
import { ArtifactViewer, type ArtifactViewerProps } from "../../src/artifacts/ArtifactViewer.js";
import { ReviewPanel, type ReviewPanelProps } from "../../src/artifacts/ArtifactReview.js";
import "../../src/styles.css";

const fixture = window as unknown as {
  __v02Props: ArtifactViewerProps;
  __v03Props?: ReviewPanelProps;
};
const root = document.getElementById("root");
if (!root) throw new Error("Synthetic viewer root is missing.");
createRoot(root).render(
  fixture.__v03Props ? (
    <main className="sheet-content" style={{ maxWidth: "472px" }}>
      <ReviewPanel {...fixture.__v03Props} />
    </main>
  ) : (
    <ArtifactViewer {...fixture.__v02Props} />
  ),
);
