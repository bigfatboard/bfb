// ABOUTME: Renders untrusted text artifact bytes into static safe HTML without scripts.
// ABOUTME: Strict subsets and hard caps keep hostile or oversized input inert and bounded.

/** Text formats the viewer renders server-side into static documents. */
export const VIEWER_TEXT_FORMATS = ["markdown", "mermaid", "diff", "json", "log"] as const;
export type ViewerTextFormat = (typeof VIEWER_TEXT_FORMATS)[number];

/** Largest source prefix ever rendered; longer input is truncated with a notice. */
export const VIEWER_MAX_SOURCE_CHARS = 262_144;
/** Largest pretty-printed JSON document kept inline before truncation. */
export const VIEWER_MAX_JSON_CHARS = 1_048_576;
/** Strict mermaid flowchart caps: nodes, edges, and label length. */
export const VIEWER_MAX_MERMAID_NODES = 200;
export const VIEWER_MAX_MERMAID_EDGES = 400;
export const VIEWER_MAX_MERMAID_LABEL_CHARS = 200;
/** Largest rendered line count kept inline before truncation. */
export const VIEWER_MAX_TEXT_LINES = 10_000;
/** Defensive ceiling on any generated document; exceeded output becomes a fallback. */
export const VIEWER_MAX_OUTPUT_BYTES = 2_097_152;

export function isViewerTextFormat(format: string): format is ViewerTextFormat {
  return (VIEWER_TEXT_FORMATS as readonly string[]).includes(format);
}

/** Escapes every HTML-significant character; rendered output never contains raw markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clipSource(source: string): { text: string; truncated: boolean } {
  if (source.length <= VIEWER_MAX_SOURCE_CHARS) return { text: source, truncated: false };
  return { text: source.slice(0, VIEWER_MAX_SOURCE_CHARS), truncated: true };
}

function clipLines(lines: string[]): { lines: string[]; truncated: boolean } {
  if (lines.length <= VIEWER_MAX_TEXT_LINES) return { lines, truncated: false };
  return { lines: lines.slice(0, VIEWER_MAX_TEXT_LINES), truncated: true };
}

function truncateNotice(shown: string): string {
  return `<p class="notice">Preview truncated: showing ${shown}. Request a narrower artifact for full review.</p>`;
}

/**
 * Single-pass inline tokenizer over raw text. Gaps are escaped; matches are
 * classified once, so generated markup is never reparsed and `*` is excluded
 * from link targets to keep emphasis parsing out of attributes.
 */
// The single group keeps matched tokens in the split output next to escaped gaps.
const INLINE_TOKEN =
  /(`[^`\n]{1,500}`|\[[^\[\]\n]{1,200}\]\(https?:\/\/[^\s<>"'`()*]{1,500}\)|\*\*[^*\n]{1,500}\*\*|\*[^*\n]{1,200}\*)/g;

function renderInline(raw: string): string {
  return raw
    .split(INLINE_TOKEN)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      if (part.startsWith("**") && part.endsWith("**") && part.length >= 5) {
        return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length >= 3) {
        return `<em>${escapeHtml(part.slice(1, -1))}</em>`;
      }
      const link = /^\[([^\[\]\n]{1,200})\]\((https?:\/\/[^\s<>"'`()*]{1,500})\)$/.exec(part);
      if (link) {
        return `<a href="${escapeHtml(link[2]!)}" rel="noopener">${escapeHtml(link[1]!)}</a>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

/**
 * Renders a strict markdown subset: ATX headings, fenced code, flat lists,
 * rules, links, emphasis, and inline code. Raw HTML is never passed through;
 * it renders as escaped text. Images degrade to their alt text.
 */
export function renderMarkdownToHtml(source: string): { html: string; truncated: boolean } {
  const clipped = clipSource(source.replace(/!\[([^\[\]\n]{0,200})\]\([^()\s]{0,500}\)/g, "$1"));
  const lines = clipped.text.split("\n");
  const body: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      body.push(`<p>${paragraph.map((line) => renderInline(line)).join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      body.push(
        `<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`,
      );
      list = null;
    }
  };
  for (const line of lines) {
    if (fence !== null) {
      if (/^```/.test(line)) {
        body.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      fence = [];
      continue;
    }
    const heading = /^(#{1,3}) ([^\n]{1,300})$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      body.push(`<h${heading[1]!.length}>${renderInline(heading[2]!)}</h${heading[1]!.length}>`);
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      body.push("<hr>");
      continue;
    }
    const ordered = /^(\d{1,4})\. ([^\n]+)$/.exec(line);
    const unordered = /^[-*] ([^\n]+)$/.exec(line);
    if (ordered || unordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const item = (ordered?.[2] ?? unordered?.[1] ?? "").slice(0, 2000);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(item);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(line.slice(0, 4000));
  }
  if (fence !== null) {
    body.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  flushList();
  if (clipped.truncated) body.push(truncateNotice("the first 256 KiB"));
  return { html: body.join("\n"), truncated: clipped.truncated };
}

const MERMAID_DANGEROUS_LINE =
  /^\s*(click|href|style|classDef|class\s|linkStyle|subgraph|direction|call|interaction)\b|javascript:|data:|on\w+\s*=|<\s*(script|iframe|object|embed|link|style|img|svg|a|form)\b/i;
const MERMAID_COMMENT_LINE = /^\s*%%/;
const MERMAID_GRAPH_LINE = /^\s*graph\s+(TD|TB|LR|RL|BT)\s*$/i;
const MERMAID_NODE_LINE =
  /^\s*([A-Za-z0-9_]{1,32})(?:\(\(([^()\n]{1,200})\)\)|\(([^()\n]{1,200})\)|\[([^\[\]\n]{1,200})\]|\{([^{}\n]{1,200})\})?\s*$/;
const MERMAID_ENDPOINT_LABEL = String.raw`(?:\(\(([^()\n]{1,200})\)\)|\(([^()\n]{1,200})\)|\[([^\[\]\n]{1,200})\]|\{([^{}\n]{1,200})\})?`;
const MERMAID_EDGE_LINE = new RegExp(
  String.raw`^\s*([A-Za-z0-9_]{1,32})` +
    MERMAID_ENDPOINT_LABEL +
    String.raw`\s*(-->|---|==>)\s*(?:\|([^|\n]{1,100})\|\s*)?([A-Za-z0-9_]{1,32})` +
    MERMAID_ENDPOINT_LABEL +
    String.raw`\s*$`,
);

interface MermaidGraph {
  nodes: Map<string, string>;
  edges: Array<{ from: string; to: string; kind: string; label: string }>;
  dropped: number;
}

/** Parses a strict flowchart subset; active directives are dropped and counted, never rendered. */
export function parseMermaidGraph(source: string): MermaidGraph | { overCap: true } {
  const clipped = clipSource(source);
  if (clipped.truncated) return { overCap: true };
  const graph: MermaidGraph = { nodes: new Map(), edges: [], dropped: 0 };
  let sawGraph = false;
  for (const rawLine of clipped.text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || MERMAID_COMMENT_LINE.test(rawLine)) continue;
    if (!sawGraph) {
      if (MERMAID_GRAPH_LINE.test(rawLine)) {
        sawGraph = true;
        continue;
      }
      graph.dropped += 1;
      continue;
    }
    if (MERMAID_DANGEROUS_LINE.test(rawLine)) {
      graph.dropped += 1;
      continue;
    }
    const edge = MERMAID_EDGE_LINE.exec(rawLine);
    if (edge) {
      if (graph.edges.length >= VIEWER_MAX_MERMAID_EDGES) return { overCap: true };
      const [
        ,
        from,
        fromStadium,
        fromRound,
        fromRect,
        fromDiamond,
        kind,
        label,
        to,
        toStadium,
        toRound,
        toRect,
        toDiamond,
      ] = edge;
      const fromLabel = (fromStadium ?? fromRound ?? fromRect ?? fromDiamond ?? from!).slice(
        0,
        VIEWER_MAX_MERMAID_LABEL_CHARS,
      );
      const toLabel = (toStadium ?? toRound ?? toRect ?? toDiamond ?? to!).slice(
        0,
        VIEWER_MAX_MERMAID_LABEL_CHARS,
      );
      for (const [id, endpointLabel] of [
        [from!, fromLabel],
        [to!, toLabel],
      ] as const) {
        if (!graph.nodes.has(id)) {
          if (graph.nodes.size >= VIEWER_MAX_MERMAID_NODES) return { overCap: true };
          graph.nodes.set(id, endpointLabel);
        } else if (endpointLabel !== id) {
          graph.nodes.set(id, endpointLabel);
        }
      }
      graph.edges.push({ from: from!, to: to!, kind: kind!, label: (label ?? "").slice(0, 100) });
      continue;
    }
    const node = MERMAID_NODE_LINE.exec(rawLine);
    if (node) {
      const id = node[1]!;
      const label = (node[2] ?? node[3] ?? node[4] ?? node[5] ?? id).slice(
        0,
        VIEWER_MAX_MERMAID_LABEL_CHARS,
      );
      if (!graph.nodes.has(id) && graph.nodes.size >= VIEWER_MAX_MERMAID_NODES) {
        return { overCap: true };
      }
      graph.nodes.set(id, label);
      continue;
    }
    graph.dropped += 1;
  }
  if (!sawGraph) return { overCap: true };
  return graph;
}

/** Renders the strict subset as static SVG: no links, no scripts, no foreign content. */
export function renderMermaidToSvg(
  source: string,
): { kind: "svg"; svg: string; dropped: number } | { kind: "fallback"; reason: string } {
  const parsed = parseMermaidGraph(source);
  if (!("nodes" in parsed)) {
    return {
      kind: "fallback",
      reason: "mermaid preview unavailable: content is outside the strict flowchart subset or exceeds graph limits",
    };
  }
  const incoming = new Map<string, number>();
  for (const id of parsed.nodes.keys()) incoming.set(id, 0);
  for (const edge of parsed.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, count] of incoming) {
    if (count === 0) {
      depth.set(id, 0);
      queue.push(id);
    }
  }
  let guard = 0;
  while (queue.length > 0 && guard < VIEWER_MAX_MERMAID_NODES * 4) {
    guard += 1;
    const id = queue.shift()!;
    for (const edge of parsed.edges) {
      if (edge.from !== id) continue;
      const next = (depth.get(id) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? -1)) {
        depth.set(edge.to, next);
        queue.push(edge.to);
      }
    }
  }
  for (const id of parsed.nodes.keys()) {
    if (!depth.has(id)) depth.set(id, 0);
  }
  const columns = new Map<number, string[]>();
  for (const [id, level] of depth) {
    const column = columns.get(level) ?? [];
    column.push(id);
    columns.set(level, column);
  }
  for (const column of columns.values()) column.sort();
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, row) => positions.set(id, { x: 20 + level * 180, y: 24 + row * 56 }));
  }
  const levels = columns.size === 0 ? 0 : Math.max(...columns.keys());
  const rows = Math.max(1, ...[...columns.values()].map((ids) => ids.length));
  const width = 20 + (levels + 1) * 180;
  const height = 24 + rows * 56 + 16;
  const shapes: string[] = [
    `<defs><marker id="bfb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#334155"></path></marker></defs>`,
  ];
  for (const edge of parsed.edges) {
    const from = positions.get(edge.from)!;
    const to = positions.get(edge.to)!;
    const dashed = edge.kind === "---" ? ` stroke-dasharray="5 4"` : "";
    const thick = edge.kind === "==>" ? ` stroke-width="2.5"` : ` stroke-width="1.5"`;
    shapes.push(
      `<line x1="${from.x + 140}" y1="${from.y + 16}" x2="${to.x}" y2="${to.y + 16}" stroke="#334155"${dashed}${thick} marker-end="url(#bfb-arrow)"></line>`,
    );
    if (edge.label) {
      const midX = Math.round((from.x + 140 + to.x) / 2);
      const midY = Math.round((from.y + to.y) / 2) + 12;
      shapes.push(
        `<text x="${midX}" y="${midY}" font-size="11" text-anchor="middle" font-family="sans-serif" fill="#475569">${escapeHtml(edge.label)}</text>`,
      );
    }
  }
  for (const [id, label] of [...parsed.nodes.entries()].sort()) {
    const at = positions.get(id)!;
    shapes.push(
      `<rect x="${at.x}" y="${at.y}" width="140" height="32" rx="6" fill="#f1f5f9" stroke="#334155"></rect>`,
    );
    shapes.push(
      `<text x="${at.x + 70}" y="${at.y + 21}" font-size="12" text-anchor="middle" font-family="sans-serif" fill="#0f172a">${escapeHtml(label)}</text>`,
    );
  }
  const notice =
    parsed.dropped > 0
      ? `<p class="notice">${parsed.dropped} line(s) outside the strict flowchart subset were omitted.</p>`
      : "";
  return {
    kind: "svg",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${Math.min(width, 1200)}" role="img">${shapes.join("")}</svg>${notice}`,
    dropped: parsed.dropped,
  };
}

/** Renders unified diffs with line classes; over-long diffs truncate with a notice. */
export function renderDiffToHtml(source: string): { html: string; truncated: boolean } {
  const clipped = clipSource(source);
  const cut = clipLines(clipped.text.split("\n"));
  const rows = cut.lines.map((line) => {
    const text = escapeHtml(line.slice(0, 4000));
    if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="add">${text}</span>`;
    if (line.startsWith("-") && !line.startsWith("---")) return `<span class="del">${text}</span>`;
    if (line.startsWith("@@")) return `<span class="hunk">${text}</span>`;
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("commit ")
    ) {
      return `<span class="meta">${text}</span>`;
    }
    return `<span>${text}</span>`;
  });
  if (clipped.truncated || cut.truncated) {
    rows.push(truncateNotice(clipped.truncated ? "the first 256 KiB" : "the first 10000 lines"));
  }
  return { html: `<pre class="diff">${rows.join("\n")}</pre>`, truncated: clipped.truncated || cut.truncated };
}

/** Pretty-prints bounded JSON; invalid JSON renders as escaped text with a note. */
export function renderJsonToHtml(source: string): { html: string; truncated: boolean } {
  const clipped = clipSource(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(clipped.text);
  } catch {
    return {
      html: `<p class="notice">Invalid JSON: showing escaped source as text.</p><pre>${escapeHtml(clipped.text.slice(0, VIEWER_MAX_JSON_CHARS))}</pre>`,
      truncated: clipped.truncated,
    };
  }
  let pretty: string;
  try {
    pretty = JSON.stringify(parsed, null, 2) ?? "null";
  } catch {
    return {
      html: `<p class="notice">JSON cannot be represented: showing escaped source as text.</p><pre>${escapeHtml(clipped.text.slice(0, VIEWER_MAX_JSON_CHARS))}</pre>`,
      truncated: clipped.truncated,
    };
  }
  if (pretty.length > VIEWER_MAX_JSON_CHARS) {
    return {
      html: `${truncateNotice("the first 1 MiB of formatted JSON")}<pre>${escapeHtml(pretty.slice(0, VIEWER_MAX_JSON_CHARS))}</pre>`,
      truncated: true,
    };
  }
  if (clipped.truncated) {
    return { html: `${truncateNotice("the first 256 KiB")}<pre>${escapeHtml(pretty)}</pre>`, truncated: true };
  }
  return { html: `<pre>${escapeHtml(pretty)}</pre>`, truncated: false };
}

/** Renders bounded log output as escaped text with line caps and truncation notices. */
export function renderLogToHtml(source: string): { html: string; truncated: boolean } {
  const clipped = clipSource(source);
  const cut = clipLines(clipped.text.split("\n"));
  const body = `<pre>${escapeHtml(cut.lines.map((line) => line.slice(0, 4000)).join("\n"))}</pre>`;
  if (clipped.truncated || cut.truncated) {
    return {
      html: `${body}${truncateNotice(clipped.truncated ? "the first 256 KiB" : "the first 10000 lines")}`,
      truncated: true,
    };
  }
  return { html: body, truncated: false };
}

const VIEWER_STYLE = [
  "body{font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#0f172a;background:#fff;max-width:72rem;margin:0 auto;padding:1.5rem;}",
  "pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:1rem;overflow:auto;}",
  "code{font-family:ui-monospace,monospace;background:#f1f5f9;border-radius:4px;padding:0 .25rem;}",
  "pre code{background:none;padding:0;}",
  ".notice{background:#fef9c3;border:1px solid #facc15;border-radius:8px;padding:.75rem 1rem;}",
  ".diff .add{color:#15803d;}.diff .del{color:#b91c1c;}.diff .hunk{color:#1d4ed8;}.diff .meta{color:#475569;font-weight:600;}",
  "a{color:#1d4ed8;}",
  "table,svg{max-width:100%;}",
].join("");

/** Fixed fallback reasons; untrusted detail never enters a fallback document. */
export type ViewerFallbackReason = "over_source_cap" | "over_graph_cap" | "unsupported";

/** Builds a static fallback document when input exceeds the strict renderer bounds. */
export function buildViewerFallback(reason: ViewerFallbackReason): string {
  const message =
    reason === "over_graph_cap"
      ? "Preview unavailable: the diagram exceeds strict node and edge limits."
      : reason === "over_source_cap"
        ? "Preview unavailable: the source exceeds strict preview limits."
        : "Preview unavailable: this content cannot be rendered in the strict preview subset.";
  return finishViewerDocument(`<p class="notice">${message}</p>`);
}

function finishViewerDocument(body: string): string {
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifact preview</title><style>${VIEWER_STYLE}</style></head><body>${body}</body></html>`;
  if (new TextEncoder().encode(document).byteLength > VIEWER_MAX_OUTPUT_BYTES) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Artifact preview</title></head><body><p>Preview unavailable: the source exceeds strict preview limits.</p></body></html>`;
  }
  return document;
}

/**
 * Builds the full redeemed document for a text artifact format. Output is
 * static markup with no scripts, event handlers, links outside http(s), or
 * embedded untrusted URLs; every byte of source passes through escaping.
 */
export function buildTextDocument(format: ViewerTextFormat, source: string): string {
  let body: string;
  if (format === "markdown") {
    body = renderMarkdownToHtml(source).html;
  } else if (format === "mermaid") {
    const rendered = renderMermaidToSvg(source);
    body = rendered.kind === "svg" ? rendered.svg : `<p class="notice">${escapeHtml(rendered.reason)}</p>`;
  } else if (format === "diff") {
    body = renderDiffToHtml(source).html;
  } else if (format === "json") {
    body = renderJsonToHtml(source).html;
  } else {
    body = renderLogToHtml(source).html;
  }
  return finishViewerDocument(body);
}
