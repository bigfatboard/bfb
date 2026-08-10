// ABOUTME: Generates checked-in TypeScript and Go wire types from protocol JSON Schemas.
// ABOUTME: Refuses silent schema drift by writing deterministic outputs and a catalog hash.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DOCUMENTS, PROTOCOL_HEAD, SCHEMA_VERSION } from "./document-names.js";

interface JsonSchema {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxProperties?: number;
}

function schemaDir(root: string): string {
  return path.join(root, "protocol/schema/v1");
}

async function loadSchema(root: string, file: string): Promise<JsonSchema> {
  const raw = await readFile(path.join(schemaDir(root), file), "utf8");
  return JSON.parse(raw) as JsonSchema;
}

function resolveRef(
  rootSchema: JsonSchema,
  ref: string,
  registry: Map<string, JsonSchema>,
): { schema: JsonSchema; owner: JsonSchema } {
  if (ref.startsWith("#/$defs/")) {
    const name = ref.slice("#/$defs/".length);
    const def = rootSchema.$defs?.[name];
    if (!def) {
      throw new Error("missing local def " + name);
    }
    return { schema: def, owner: rootSchema };
  }
  const [file, fragment] = ref.split("#");
  if (!file) {
    throw new Error("unsupported ref " + ref);
  }
  const target = registry.get(file);
  if (!target) {
    throw new Error("missing schema file for ref " + ref);
  }
  if (!fragment) {
    return { schema: target, owner: target };
  }
  if (fragment.startsWith("/$defs/")) {
    const name = fragment.slice("/$defs/".length);
    const def = target.$defs?.[name];
    if (!def) {
      throw new Error("missing def " + name + " in " + file);
    }
    return { schema: def, owner: target };
  }
  throw new Error("unsupported ref fragment " + ref);
}

function tsTypeOf(
  schema: JsonSchema,
  rootSchema: JsonSchema,
  registry: Map<string, JsonSchema>,
  forceOptional = false,
): string {
  if (schema.$ref) {
    const resolved = resolveRef(rootSchema, schema.$ref, registry);
    return tsTypeOf(resolved.schema, resolved.owner, registry, forceOptional);
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (schema.enum) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const type = schema.type;
  if (type === "string") {
    return "string";
  }
  if (type === "integer" || type === "number") {
    return "number";
  }
  if (type === "boolean") {
    return "boolean";
  }
  if (type === "array") {
    const items = schema.items ? tsTypeOf(schema.items, rootSchema, registry) : "unknown";
    return items + "[]";
  }
  if (type === "object") {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      return "Record<string, never>";
    }
    const required = new Set(schema.required ?? []);
    const lines = Object.entries(schema.properties).map(([key, value]) => {
      const optional = !required.has(key) || forceOptional;
      return (
        "  " + key + (optional ? "?" : "") + ": " + tsTypeOf(value, rootSchema, registry) + ";"
      );
    });
    return "{\n" + lines.join("\n") + "\n}";
  }
  return "unknown";
}

function goTypeOf(
  schema: JsonSchema,
  rootSchema: JsonSchema,
  registry: Map<string, JsonSchema>,
  fieldName: string,
): string {
  if (schema.$ref) {
    if (schema.$ref.includes("Ulid") || schema.$ref.endsWith("/Ulid")) {
      return "string";
    }
    if (schema.$ref.includes("TypedError")) {
      return "TypedError";
    }
    if (schema.$ref.includes("PrincipalRef")) {
      return "PrincipalRef";
    }
    if (schema.$ref.includes("SourceRef")) {
      return "SourceRef";
    }
    const resolved = resolveRef(rootSchema, schema.$ref, registry);
    return goTypeOf(resolved.schema, resolved.owner, registry, fieldName);
  }
  if (schema.enum || schema.const !== undefined) {
    if (typeof schema.const === "string" || typeof schema.enum?.[0] === "string") {
      return "string";
    }
    if (typeof schema.const === "number" || typeof schema.enum?.[0] === "number") {
      return "int64";
    }
    if (typeof schema.const === "boolean" || typeof schema.enum?.[0] === "boolean") {
      return "bool";
    }
  }
  const type = schema.type;
  if (type === "string") {
    return "string";
  }
  if (type === "integer") {
    return "int64";
  }
  if (type === "number") {
    return "float64";
  }
  if (type === "boolean") {
    return "bool";
  }
  if (type === "array") {
    const items = schema.items ? goTypeOf(schema.items, rootSchema, registry, fieldName) : "any";
    return "[]" + items;
  }
  if (type === "object") {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      return "map[string]any";
    }
    // inline nested object as map for simplicity unless known named
    if (fieldName === "ExecutionConfig" || fieldName === "execution_config") {
      return "ExecutionConfig";
    }
    return "map[string]any";
  }
  return "any";
}

function goFieldName(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

async function hashSchemas(root: string): Promise<string> {
  const dir = schemaDir(root);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function generateProtocol(
  root: string,
  options: { formatCwd?: string } = {},
): Promise<{ schemaHash: string }> {
  const registry = new Map<string, JsonSchema>();
  const schemaFiles = (await readdir(schemaDir(root)))
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const file of schemaFiles) {
    registry.set(file, await loadSchema(root, file));
  }
  const primitives = registry.get("primitives.json");
  if (!primitives) {
    throw new Error("primitives.json missing");
  }

  const schemaHash = await hashSchemas(root);
  const tsOutDir = path.join(root, "packages/protocol-ts/src/generated");
  const goOutDir = path.join(root, "internal/protocol/generated");
  await mkdir(tsOutDir, { recursive: true });
  await mkdir(goOutDir, { recursive: true });

  const tsParts: string[] = [
    "// Code generated by tools/protocol. DO NOT EDIT.",
    "// Protocol: " + PROTOCOL_HEAD,
    "// Schema hash: " + schemaHash,
    "",
    "export const PROTOCOL_HEAD = " + JSON.stringify(PROTOCOL_HEAD) + " as const;",
    "export const SCHEMA_VERSION = " + SCHEMA_VERSION + " as const;",
    "export const SCHEMA_HASH = " + JSON.stringify(schemaHash) + " as const;",
    "",
  ];

  // Shared nested types from primitives
  const principalRef = resolveRef(primitives, "#/$defs/PrincipalRef", registry);
  tsParts.push(
    "export type PrincipalRef = " +
      tsTypeOf(principalRef.schema, principalRef.owner, registry) +
      ";",
  );
  const sourceRef = resolveRef(primitives, "#/$defs/SourceRef", registry);
  tsParts.push(
    "export type SourceRef = " + tsTypeOf(sourceRef.schema, sourceRef.owner, registry) + ";",
  );
  const typedError = resolveRef(primitives, "#/$defs/TypedError", registry);
  tsParts.push(
    "export type TypedError = " + tsTypeOf(typedError.schema, typedError.owner, registry) + ";",
  );
  tsParts.push("");

  for (const doc of DOCUMENTS) {
    if (doc.name === "typed-error") {
      // TypedError is already emitted from primitives.
      continue;
    }
    const schema = registry.get(doc.schemaFile);
    if (!schema) {
      throw new Error("missing schema " + doc.schemaFile);
    }
    const body = tsTypeOf(schema, schema, registry);
    tsParts.push("export type " + doc.tsType + " = " + body + ";");
    tsParts.push("");
  }

  tsParts.push(
    "export type WireDocumentName =\n" +
      DOCUMENTS.map((doc) => '  | "' + doc.name + '"').join("\n") +
      ";",
  );
  tsParts.push("");
  tsParts.push(
    "export const WIRE_DOCUMENT_NAMES = " +
      JSON.stringify(
        DOCUMENTS.map((doc) => doc.name),
        null,
        2,
      ) +
      " as const;",
  );

  await writeFile(path.join(tsOutDir, "types.ts"), tsParts.join("\n") + "\n");

  // Go generation
  const goParts: string[] = [
    "// Code generated by tools/protocol. DO NOT EDIT.",
    "// Protocol: " + PROTOCOL_HEAD,
    "// Schema hash: " + schemaHash,
    "",
    "package generated",
    "",
    "const (",
    '\tProtocolHead  = "' + PROTOCOL_HEAD + '"',
    "\tSchemaVersion = " + SCHEMA_VERSION,
    '\tSchemaHash    = "' + schemaHash + '"',
    ")",
    "",
    "type PrincipalRef struct {",
    '\tType string `json:"type"`',
    '\tID   string `json:"id"`',
    "}",
    "",
    "type SourceRef struct {",
    '\tType     string  `json:"type"`',
    '\tID       string  `json:"id"`',
    '\tProvider *string `json:"provider,omitempty"`',
    "}",
    "",
    "type TypedError struct {",
    '\tSchemaVersion int     `json:"schema_version"`',
    '\tCategory      string  `json:"category"`',
    '\tCode          string  `json:"code"`',
    '\tMessage       string  `json:"message"`',
    '\tPath          *string `json:"path,omitempty"`',
    "}",
    "",
    "type ExecutionConfig struct {",
    '\tProvider             string   `json:"provider"`',
    '\tMode                 string   `json:"mode"`',
    '\tModel                string   `json:"model"`',
    '\tEffort               string   `json:"effort"`',
    '\tApprovalPolicy       string   `json:"approval_policy"`',
    '\tFilesystemPolicy     string   `json:"filesystem_policy"`',
    '\tContextInjection     string   `json:"context_injection"`',
    '\tInitialTurnTransport string   `json:"initial_turn_transport"`',
    '\tRequiredCapabilities []string `json:"required_capabilities"`',
    "}",
    "",
  ];

  for (const doc of DOCUMENTS) {
    if (doc.name === "typed-error") {
      continue;
    }
    const schema = registry.get(doc.schemaFile);
    if (!schema?.properties) {
      throw new Error("schema without properties: " + doc.schemaFile);
    }
    const required = new Set(schema.required ?? []);
    goParts.push("type " + doc.goType + " struct {");
    for (const [key, value] of Object.entries(schema.properties)) {
      const field = goFieldName(key);
      let gType = goTypeOf(value, schema, registry, key);
      if (key === "execution_config") {
        gType = "ExecutionConfig";
      }
      if (key === "actor") {
        gType = "PrincipalRef";
      }
      if (key === "source") {
        gType = "SourceRef";
      }
      if (key === "diagnostic" || key === "error" || key === "rejection") {
        gType = "*TypedError";
      }
      if (key === "payload") {
        gType = "map[string]any";
      }
      const omit = required.has(key) ? "" : ",omitempty";
      // pointer for optional non-slice fields
      if (
        !required.has(key) &&
        !gType.startsWith("[]") &&
        !gType.startsWith("map[") &&
        !gType.startsWith("*")
      ) {
        if (gType === "string" || gType === "int64" || gType === "bool" || gType === "float64") {
          gType = "*" + gType;
        }
      }
      goParts.push("\t" + field + " " + gType + ' `json:"' + key + omit + '"`');
    }
    goParts.push("}");
    goParts.push("");
  }

  goParts.push("var DocumentNames = []string{");
  for (const doc of DOCUMENTS) {
    goParts.push('\t"' + doc.name + '",');
  }
  goParts.push("}");
  goParts.push("");

  await writeFile(path.join(goOutDir, "types.go"), goParts.join("\n") + "\n");

  // Catalog stamp for drift checks
  await writeFile(
    path.join(tsOutDir, "catalog.json"),
    JSON.stringify(
      {
        protocol: PROTOCOL_HEAD,
        schema_version: SCHEMA_VERSION,
        schema_hash: schemaHash,
        documents: DOCUMENTS.map((doc) => ({ name: doc.name, schema: doc.schemaFile })),
      },
      null,
      2,
    ) + "\n",
  );

  // Keep generated TypeScript within repository Prettier policy so drift checks stay stable.
  const formatRoot = options.formatCwd ?? root;
  const prettierBin = path.join(formatRoot, "node_modules/prettier/bin/prettier.cjs");
  const prettierConfig = path.join(formatRoot, "prettier.config.mjs");
  execFileSync(
    process.execPath,
    [
      prettierBin,
      "--config",
      prettierConfig,
      "--write",
      path.join(tsOutDir, "types.ts"),
      path.join(tsOutDir, "catalog.json"),
    ],
    { cwd: formatRoot, stdio: "pipe" },
  );
  execFileSync("gofmt", ["-w", path.join(goOutDir, "types.go")], { stdio: "pipe" });

  return { schemaHash };
}

const isMain = process.argv[1]?.endsWith("generate.ts") || process.argv[1]?.endsWith("generate.js");
if (isMain) {
  const root = process.cwd();
  const result = await generateProtocol(root, { formatCwd: root });
  console.log(
    "protocol generate: wrote types (schema hash " + result.schemaHash.slice(0, 12) + "…)",
  );
}
