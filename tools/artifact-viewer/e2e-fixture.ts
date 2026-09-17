// ABOUTME: Starts self-contained app and artifact origins for V02 browser proof.
// ABOUTME: Real migrated D1 and the production worker handler back every preview.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  adaptBetterSqlite3,
  applyMigrationsForVerification,
  type MigrationDatabase,
  type SqlDatabase,
} from "@bfb/db";
import {
  createArtifactCommand,
  createViewGrantCommand,
  finalizeArtifactCommand,
  FIX,
  issueViewGrantResponse,
  mintUploadGrantSecret,
  mintViewGrantSecret,
  mintViewNonce,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  seedSyntheticWorkspace,
  WorkspaceHub,
  artifactObjectKey,
} from "@bfb/domain";
import { createArtifactFetchHandler } from "@bfb/artifact-worker";

const SESSION_HASH = createHash("sha256").update("v02-e2e-session").digest("hex");
const ABUSE_SECRET = "v02-e2e-artifact-abuse-secret-9f27c4axx-long";
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations/d1",
);

export function v02Digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Self-reporting probe: every attack reports its own outcome to the driver
// page. Reports are test data only; the driver never treats them as authority
// and the app-hit log independently proves no exfiltration arrived.
export function v02ProbeScript(app: string): string {
  return [
    `const R=(attack,result)=>parent.postMessage({v02probe:1,attack,result:String(result)},"*");`,
    `try{R("cookie",document.cookie||"empty-cookie");}catch(e){R("cookie","blocked-throw");}`,
    `R("referrer",document.referrer);`,
    `R("location",location.href);`,
    `R("history",String(history.length));`,
    `fetch("${app}/__test/hit?t=api").then(()=> "fetched",e=>"blocked:"+(e&&e.name)).then(v=>R("api",v));`,
    `new Promise(res=>{const img=new Image();img.onload=()=>res("loaded");img.onerror=()=>res("blocked");img.src="${app}/__test/hit?t=img";setTimeout(()=>res("timeout"),1500);}).then(v=>R("img",v));`,
    `try{const w=window.open("${app}/__test/hit?t=popup");R("popup",w===null?"blocked-null":"opened");}catch(e){R("popup","blocked-throw");}`,
    `try{top.location.href="${app}/__test/hit?t=topnav";R("topnav-scheduled","no-throw");}catch(e){R("topnav-scheduled","throw");}`,
    `setTimeout(()=>R("topnav",location.href),800);`,
    `try{localStorage.setItem("x","1");R("storage","writable");}catch(e){R("storage","blocked");}`,
    `try{parent.document.title;R("parent-dom","readable");}catch(e){R("parent-dom","blocked");}`,
    `const f=document.createElementNS("http://www.w3.org/1999/xhtml","form");f.method="POST";f.action="${app}/__test/hit?t=form";const i=document.createElementNS("http://www.w3.org/1999/xhtml","input");i.name="x";i.value="1";f.appendChild(i);(document.body||document.documentElement).appendChild(f);try{f.submit();}catch(e){}`,
    `setTimeout(()=>R("form","still-here:"+location.href),1000);`,
    `const a=document.createElementNS("http://www.w3.org/1999/xhtml","a");a.href="data:text/html,hi";a.download="x.html";(document.body||document.documentElement).appendChild(a);a.click();R("download-clicked","clicked");`,
  ].join("");
}

export const V02_MD_HOSTILE = `# synthetic review\n\n</script><script>alert(document.cookie)</script>\n\n<img src=x onerror=alert(1)>\n`;
export const V02_MERMAID_HOSTILE = `graph TD\nA-->B\nclick A javascript:alert(document.cookie)\nB-->C\n`;

export interface V02E2EGrant {
  view_id: string;
  secret: string;
  nonce: string;
}

export interface V02E2EFixture {
  db: SqlDatabase;
  appUrl: string;
  artUrl: string;
  versions: Record<string, string>;
  hits: Array<{ url: string; referer: string; cookie: boolean }>;
  cookieSightings(): number;
  redeemSuccess(): number;
  redeemError(): number;
  issueGrant(versionId: string): Promise<V02E2EGrant>;
  close(): Promise<void>;
}

async function publish(
  db: SqlDatabase,
  objects: Map<string, Uint8Array>,
  format: string,
  bytes: Uint8Array,
  now: string,
): Promise<string> {
  const hub = new WorkspaceHub(db);
  const minted = mintUploadGrantSecret();
  const created = await hub.execute(createArtifactCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now,
    idempotencyKey: randomUlid(),
    input: {
      artifactId: null,
      runId: null,
      format: format as never,
      role: "review" as never,
      declaredSize: bytes.byteLength,
      expectedDigest: v02Digest(bytes),
      grantSecretHash: minted.secretHash,
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  await redeemUploadGrant(db, {
    grantId: created.result.upload_grant.grant_id,
    secret: minted.secret,
    now,
  });
  const key = artifactObjectKey({
    workspaceId: FIX.workspace,
    role: "review",
    runId: null,
    versionId: created.result.version_id,
    contentHash: v02Digest(bytes),
  });
  objects.set(key, bytes);
  await recordVerifiedUpload(db, {
    workspaceId: FIX.workspace,
    versionId: created.result.version_id,
    runId: null,
    role: "review",
    contentHash: v02Digest(bytes),
    r2Key: key,
    size: bytes.byteLength,
    now,
  });
  const finalized = await hub.execute(finalizeArtifactCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now,
    idempotencyKey: randomUlid(),
    input: {
      versionId: created.result.version_id,
      contentHash: v02Digest(bytes),
      size: bytes.byteLength,
    },
  });
  if (!finalized.ok) throw new Error(JSON.stringify(finalized));
  return created.result.version_id;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Starts the two-origin fixture. The view grant is minted by the caller
 * through `issueGrant`; the secret reaches the driver page through script
 * injection, never through a URL.
 */
export async function startV02E2EFixture(options: {
  appPort: number;
  artPort: number;
  now?: string;
}): Promise<V02E2EFixture> {
  const now = options.now ?? "2026-09-17T12:00:00.000Z";
  const appUrl = `http://bfb.localhost:${options.appPort}`;
  const artUrl = `http://artifacts.bfb.localhost:${options.artPort}`;
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw as unknown as MigrationDatabase, migrationsDir);
  const db = adaptBetterSqlite3(raw);
  await seedSyntheticWorkspace(db, now, "global");
  const objects = new Map<string, Uint8Array>();
  const hits: V02E2EFixture["hits"] = [];
  const state = { redeemSuccess: 0, redeemError: 0, cookieSightings: 0 };

  const versions = {
    html: await publish(
      db,
      objects,
      "html",
      new TextEncoder().encode(
        `<!doctype html><html><body><script>${v02ProbeScript(appUrl)}</script></body></html>`,
      ),
      now,
    ),
    svg: await publish(
      db,
      objects,
      "svg",
      new TextEncoder().encode(
        // XML-escaped so the SVG document parses; the script runs identically.
        `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>${v02ProbeScript(appUrl).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</script></svg>`,
      ),
      now,
    ),
    png: await publish(
      db,
      objects,
      "png",
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]),
      now,
    ),
    markdown: await publish(db, objects, "markdown", new TextEncoder().encode(V02_MD_HOSTILE), now),
    mermaid: await publish(
      db,
      objects,
      "mermaid",
      new TextEncoder().encode(V02_MERMAID_HOSTILE),
      now,
    ),
    mermaidHuge: await publish(
      db,
      objects,
      "mermaid",
      new TextEncoder().encode(
        `graph TD\n${Array.from({ length: 500 }, (_, i) => `N${i}-->M${i}`).join("\n")}\n`,
      ),
      now,
    ),
  };

  const bucket = {
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        key,
        size: bytes.byteLength,
        async arrayBuffer() {
          return bytes.slice().buffer as ArrayBuffer;
        },
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
  const handler = createArtifactFetchHandler({ db, now });
  const artifactEnv = {
    ARTIFACTS: bucket,
    DB: {} as D1Database,
    ARTIFACT_ORIGIN: artUrl,
    APP_ORIGIN: appUrl,
    ENVIRONMENT: "local",
    UPLOAD_ABUSE_SECRET: ABUSE_SECRET,
  };

  const artifactServer = createServer((req, res) => {
    void (async () => {
      try {
        if ((req.headers.cookie ?? "").includes("bfb_session")) state.cookieSightings += 1;
        const url = new URL(req.url ?? "/", artUrl);
        const body = await readBody(req);
        const request = new Request(artUrl + url.pathname + url.search, {
          method: req.method ?? "GET",
          headers: req.headers as Record<string, string>,
          ...(body.length > 0 ? { body: body as unknown as BodyInit } : {}),
        });
        const response = await handler(request, artifactEnv);
        if (url.pathname.includes("/redeem")) {
          if (response.status === 200) state.redeemSuccess += 1;
          else state.redeemError += 1;
        }
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() === "set-cookie") return;
          res.setHeader(key, value);
        });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.statusCode = 500;
        res.end();
      }
    })();
  });

  const appServer = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", appUrl);
        if (url.pathname === "/__test/hit") {
          hits.push({
            url: url.toString(),
            referer: req.headers.referer ?? "",
            cookie: (req.headers.cookie ?? "").includes("bfb_session="),
          });
          res.statusCode = 204;
          res.end();
          return;
        }
        if (url.pathname === "/__test/iframe") {
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("set-cookie", "bfb_session=v02-e2e-probe; Path=/; HttpOnly; SameSite=Lax");
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>driver</title></head><body>
<script>window.__reports=[];window.__artifact=${JSON.stringify(artUrl)};</script>
<script>
window.addEventListener("message",(event)=>{
  const d=event.data;
  if(d&&typeof d==="object"&&d.v02probe===1&&typeof d.attack==="string"&&typeof d.result==="string"){window.__reports.push(d);}
  if(!event.source||!document.querySelector("iframe")||event.source!==document.querySelector("iframe").contentWindow)return;
  if(!d||typeof d!=="object"||d.type!=="bfb-view-ready"||Object.keys(d).length!==1)return;
  if(!event.ports||event.ports.length!==1)return;
  const params=new URLSearchParams(location.search);
  const mode=params.get("mode")||"valid";
  const port=event.ports[0];
  if(mode==="no-port")return;
  if(mode==="wrong-nonce"){port.postMessage({type:"bfb-view-grant",secret:window.__injectedSecret,nonce:"0".repeat(32)});}
  else{port.postMessage({type:"bfb-view-grant",secret:window.__injectedSecret,nonce:window.__injectedNonce});}
  if(mode==="double"){port.postMessage({type:"bfb-view-grant",secret:window.__injectedSecret,nonce:window.__injectedNonce});}
});
window.addEventListener("load",()=>{
  const params=new URLSearchParams(location.search);
  const frame=document.createElement("iframe");
  frame.setAttribute("sandbox","allow-scripts allow-forms");
  frame.src=window.__artifact+"/view/"+params.get("view");
  document.body.appendChild(frame);
});
</script></body></html>`);
          return;
        }
        if (url.pathname === "/__test/toplevel") {
          const view = url.searchParams.get("view") ?? "";
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>driver</title></head><body>
<form id="redeem" method="POST" action="${artUrl}/view/${encodeURIComponent(view)}/redeem">
<input type="hidden" name="view_secret" value="">
<input type="hidden" name="view_nonce" value="">
</form>
<script>
document.querySelector("[name=view_secret]").value=window.__injectedSecret;
document.querySelector("[name=view_nonce]").value=window.__injectedNonce;
document.getElementById("redeem").submit();
</script></body></html>`);
          return;
        }
        res.statusCode = 404;
        res.end();
      } catch {
        res.statusCode = 500;
        res.end();
      }
    })();
  });

  await new Promise<void>((resolve) => artifactServer.listen(options.artPort, "::", resolve));
  await new Promise<void>((resolve) => appServer.listen(options.appPort, "::", resolve));

  async function issueGrant(versionId: string): Promise<V02E2EGrant> {
    const hub = new WorkspaceHub(db);
    const minted = mintViewGrantSecret();
    const nonce = mintViewNonce();
    const outcome = await hub.execute(createViewGrantCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now,
      idempotencyKey: randomUlid(),
      input: {
        versionId,
        grantSecretHash: minted.secretHash,
        viewNonce: nonce,
        sessionHash: SESSION_HASH,
      },
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    const issued = issueViewGrantResponse(outcome.result, minted.secret, nonce);
    return { view_id: issued.view_id, secret: issued.secret, nonce: issued.nonce };
  }

  return {
    db,
    appUrl,
    artUrl,
    versions,
    hits,
    cookieSightings: () => state.cookieSightings,
    redeemSuccess: () => state.redeemSuccess,
    redeemError: () => state.redeemError,
    issueGrant,
    async close() {
      await new Promise<void>((resolve, reject) =>
        artifactServer.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        appServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
