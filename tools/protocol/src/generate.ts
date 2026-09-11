// ABOUTME: Generates checked-in TypeScript and Go wire types from protocol JSON Schemas.
// ABOUTME: Refuses silent schema drift by writing deterministic outputs and a catalog hash.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import standaloneModule from "ajv/dist/standalone/index.js";
import formatsModule from "ajv-formats";
import { build } from "esbuild";

import { DOCUMENTS, PROTOCOL_HEAD, SCHEMA_VERSION } from "./document-names.js";

interface JsonSchema {
  $id?: string;
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
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  not?: JsonSchema;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxProperties?: number;
}

const EXPORTED_PRIMITIVES = [
  "Ulid",
  "UtcTimestamp",
  "ResourceVersion",
  "WorkspaceCursor",
  "SourceSequence",
  "AssignmentGeneration",
  "IdempotencyKey",
  "OpaqueToken",
  "BoundedLabel",
  "BoundedText",
  "Sha256Digest",
  "PaginationCursor",
  "PageLimit",
  "EmptyObject",
  "PaginationRequest",
  "PaginationResponse",
  "PrincipalType",
  "PrincipalRef",
  "SourceType",
  "ProviderName",
  "SourceRef",
  "AuthorizationEpoch",
  "AuthorizationRef",
  "DiagnosticCategory",
  "TypedError",
] as const;

const exportedPrimitiveSet = new Set<string>(EXPORTED_PRIMITIVES);
const addFormats = formatsModule as unknown as (typeof import("ajv-formats"))["default"];
const standaloneCode =
  standaloneModule as unknown as (typeof import("ajv/dist/standalone/index.js"))["default"];

function validatorExportName(documentName: string): string {
  return (
    documentName.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase()) +
    "Validator"
  );
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
  if (Array.isArray(type) && type.length === 2 && type.includes("null")) {
    const nonNull = type.find((item) => item !== "null")!;
    return tsTypeOf({ ...schema, type: nonNull }, rootSchema, registry, forceOptional) + " | null";
  }
  if (type === "string") {
    return "string";
  }
  if (type === "integer" || type === "number") {
    return "number";
  }
  if (type === "boolean") {
    return "boolean";
  }
  if (type === "null") {
    return "null";
  }
  if (type === "array") {
    const items = schema.items ? tsTypeOf(schema.items, rootSchema, registry) : "unknown";
    return (items.includes(" | ") ? "(" + items + ")" : items) + "[]";
  }
  if (type === "object") {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      return "Record<string, never>";
    }
    return tsObjectShape(schema, rootSchema, registry, {
      forceOptional,
      required: new Set(schema.required ?? []),
    });
  }
  return "unknown";
}

function tsObjectShape(
  schema: JsonSchema,
  rootSchema: JsonSchema,
  registry: Map<string, JsonSchema>,
  options: {
    forceOptional?: boolean;
    required: Set<string>;
    overrides?: Map<string, JsonSchema>;
    forbidden?: Set<string>;
  },
): string {
  const lines = Object.entries(schema.properties ?? {}).map(([key, value]) => {
    if (options.forbidden?.has(key)) {
      return "  " + key + "?: never;";
    }
    const optional = !options.required.has(key) || options.forceOptional;
    return (
      "  " +
      key +
      (optional ? "?" : "") +
      ": " +
      tsTypeOf(options.overrides?.get(key) ?? value, rootSchema, registry) +
      ";"
    );
  });
  return "{\n" + lines.join("\n") + "\n}";
}

function discriminatedUnionType(
  schema: JsonSchema,
  registry: Map<string, JsonSchema>,
): string | undefined {
  if (schema.type !== "object" || !schema.properties || !schema.allOf) {
    return undefined;
  }
  for (const [discriminator, property] of Object.entries(schema.properties)) {
    const values = property.enum?.filter((value): value is string => typeof value === "string");
    if (!values || values.length !== property.enum?.length) {
      continue;
    }
    const variants: string[] = [];
    for (const value of values) {
      const branches = schema.allOf.filter((branch) => {
        const condition = branch.if?.properties?.[discriminator];
        return condition?.const === value || condition?.enum?.includes(value) === true;
      });
      if (branches.length === 0) {
        variants.length = 0;
        break;
      }
      const required = new Set(schema.required ?? []);
      const forbidden = new Set<string>();
      const overrides = new Map<string, JsonSchema>([[discriminator, { const: value }]]);
      for (const branch of branches) {
        for (const key of branch.then?.required ?? []) {
          required.add(key);
        }
        for (const key of branch.then?.not?.required ?? []) {
          forbidden.add(key);
        }
        for (const [key, property] of Object.entries(branch.then?.properties ?? {})) {
          overrides.set(key, { ...schema.properties[key], ...property });
        }
      }
      variants.push(
        tsObjectShape(schema, schema, registry, {
          required,
          forbidden,
          overrides,
        }),
      );
    }
    if (variants.length === values.length) {
      return variants.join(" |\n");
    }
  }
  return undefined;
}

function goTypeOf(
  schema: JsonSchema,
  rootSchema: JsonSchema,
  registry: Map<string, JsonSchema>,
  fieldName: string,
): string {
  if (schema.$ref) {
    const primitiveName = schema.$ref.split("/").at(-1);
    if (primitiveName && exportedPrimitiveSet.has(primitiveName)) {
      return primitiveName;
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
  if (Array.isArray(type) && type.length === 2 && type.includes("null")) {
    const nonNull = type.find((item) => item !== "null")!;
    const nullable = goTypeOf({ ...schema, type: nonNull }, rootSchema, registry, fieldName);
    return nullable.startsWith("map[") || nullable.startsWith("[]") ? nullable : "*" + nullable;
  }
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

function goStructLines(
  name: string,
  schema: JsonSchema,
  rootSchema: JsonSchema,
  registry: Map<string, JsonSchema>,
): string[] {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return ["type " + name + " struct{}", ""];
  }
  const required = new Set(schema.required ?? []);
  const lines = ["type " + name + " struct {"];
  for (const [key, value] of Object.entries(schema.properties)) {
    let fieldType = goTypeOf(value, rootSchema, registry, key);
    if (
      !required.has(key) &&
      !fieldType.startsWith("[]") &&
      !fieldType.startsWith("map[") &&
      !fieldType.startsWith("*")
    ) {
      fieldType = "*" + fieldType;
    }
    const omit = required.has(key) ? "" : ",omitempty";
    lines.push("\t" + goFieldName(key) + " " + fieldType + ' `json:"' + key + omit + '"`');
  }
  lines.push("}", "");
  return lines;
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
  const schemaIDs = new Set<string>();
  const schemaFiles = (await readdir(schemaDir(root)))
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const file of schemaFiles) {
    const schema = await loadSchema(root, file);
    if (!schema.$id) {
      throw new Error("schema has no $id: " + file);
    }
    if (schemaIDs.has(schema.$id)) {
      throw new Error("duplicate schema $id: " + schema.$id);
    }
    schemaIDs.add(schema.$id);
    registry.set(file, schema);
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

  for (const primitiveName of EXPORTED_PRIMITIVES) {
    const primitive = resolveRef(primitives, "#/$defs/" + primitiveName, registry);
    tsParts.push(
      "export type " +
        primitiveName +
        " = " +
        tsTypeOf(primitive.schema, primitive.owner, registry) +
        ";",
    );
  }
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
    const body = discriminatedUnionType(schema, registry) ?? tsTypeOf(schema, schema, registry);
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

  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    ownProperties: true,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
    validateSchema: true,
    code: { esm: true, lines: true, source: true },
  });
  addFormats(ajv, { formats: ["date-time"], keywords: false, mode: "full" });
  for (const file of schemaFiles) {
    const schema = registry.get(file);
    if (!schema) {
      throw new Error("missing loaded schema " + file);
    }
    ajv.addSchema(schema, file);
  }
  for (const file of schemaFiles) {
    if (!ajv.getSchema(file)) {
      throw new Error("schema did not compile: " + file);
    }
  }
  const validatorRefs = Object.fromEntries(
    DOCUMENTS.map((doc) => [validatorExportName(doc.name), doc.schemaFile]),
  );
  const validatorSource = standaloneCode(ajv, validatorRefs);
  const validatorRegistry =
    "export const WIRE_VALIDATORS = {\n" +
    DOCUMENTS.map(
      (doc) => "  " + JSON.stringify(doc.name) + ": " + validatorExportName(doc.name) + ",",
    ).join("\n") +
    "\n};\n";
  const validatorBundle = await build({
    bundle: true,
    format: "esm",
    legalComments: "none",
    metafile: true,
    platform: "neutral",
    stdin: {
      contents: validatorSource + "\n" + validatorRegistry,
      loader: "js",
      resolveDir: path.dirname(fileURLToPath(import.meta.url)),
      sourcefile: "wire-validators.mjs",
    },
    target: "es2023",
    treeShaking: true,
    write: false,
    banner: {
      js:
        "// Code generated by tools/protocol. DO NOT EDIT.\n" +
        "// @ts-nocheck -- AJV emits JavaScript; the codec owns its typed facade.\n" +
        "/* oxlint-disable */\n" +
        "// Protocol: " +
        PROTOCOL_HEAD +
        "\n" +
        "// Schema hash: " +
        schemaHash,
    },
  });
  const externalImports = Object.values(validatorBundle.metafile.outputs).flatMap((output) =>
    output.imports.filter((dependency) => dependency.external),
  );
  if (externalImports.length > 0) {
    throw new Error(
      "standalone validator bundle has external imports: " +
        externalImports.map((dependency) => dependency.path).join(", "),
    );
  }
  const validatorOutput = validatorBundle.outputFiles[0];
  if (!validatorOutput) {
    throw new Error("standalone validator bundle produced no output");
  }
  await writeFile(path.join(tsOutDir, "validators.ts"), validatorOutput.text);

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
  ];

  for (const primitiveName of EXPORTED_PRIMITIVES) {
    const primitive = resolveRef(primitives, "#/$defs/" + primitiveName, registry);
    const primitiveType = goTypeOf(primitive.schema, primitive.owner, registry, primitiveName);
    if (primitive.schema.type === "object") {
      continue;
    }
    goParts.push("type " + primitiveName + " = " + primitiveType, "");
  }
  for (const primitiveName of EXPORTED_PRIMITIVES) {
    const primitive = resolveRef(primitives, "#/$defs/" + primitiveName, registry);
    if (primitive.schema.type !== "object") {
      continue;
    }
    goParts.push(...goStructLines(primitiveName, primitive.schema, primitive.owner, registry));
  }

  const launchSchema = registry.get("launch-specification.json");
  const executionConfig = launchSchema?.properties?.execution_config;
  if (!launchSchema || !executionConfig) {
    throw new Error("launch specification execution_config missing");
  }
  goParts.push(...goStructLines("ExecutionConfig", executionConfig, launchSchema, registry));

  for (const doc of DOCUMENTS) {
    if (doc.name === "typed-error") {
      continue;
    }
    const schema = registry.get(doc.schemaFile);
    if (!schema?.properties) {
      throw new Error("schema without properties: " + doc.schemaFile);
    }
    goParts.push(...goStructLines(doc.goType, schema, schema, registry));
  }

  goParts.push("var DocumentNames = []string{");
  for (const doc of DOCUMENTS) {
    goParts.push('\t"' + doc.name + '",');
  }
  goParts.push("}");
  goParts.push("");

  await writeFile(path.join(goOutDir, "types.go"), goParts.join("\n") + "\n");

  const goSchemaParts = [
    "// Code generated by tools/protocol. DO NOT EDIT.",
    "// Protocol: " + PROTOCOL_HEAD,
    "// Schema hash: " + schemaHash,
    "",
    "package generated",
    "",
    "var SchemaResourceIDs = []string{",
  ];
  const schemaResources: Array<{ id: string; source: string }> = [];
  for (const file of schemaFiles) {
    const schema = registry.get(file);
    if (!schema?.$id) {
      throw new Error("schema has no $id: " + file);
    }
    schemaResources.push({
      id: schema.$id,
      source: await readFile(path.join(schemaDir(root), file), "utf8"),
    });
    goSchemaParts.push("\t" + JSON.stringify(schema.$id) + ",");
  }
  goSchemaParts.push("}", "", "var SchemaResources = map[string]string{");
  for (const resource of schemaResources) {
    goSchemaParts.push(
      "\t" + JSON.stringify(resource.id) + ": " + JSON.stringify(resource.source) + ",",
    );
  }
  goSchemaParts.push("}", "", "var SchemaIDByDocument = map[string]string{");
  for (const doc of DOCUMENTS) {
    const schema = registry.get(doc.schemaFile);
    if (!schema?.$id) {
      throw new Error("document schema has no $id: " + doc.schemaFile);
    }
    goSchemaParts.push("\t" + JSON.stringify(doc.name) + ": " + JSON.stringify(schema.$id) + ",");
  }
  goSchemaParts.push("}", "");
  await writeFile(path.join(goOutDir, "schemas.go"), goSchemaParts.join("\n"));

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
      path.join(tsOutDir, "validators.ts"),
      path.join(tsOutDir, "catalog.json"),
    ],
    { cwd: formatRoot, stdio: "pipe" },
  );
  execFileSync("gofmt", ["-w", path.join(goOutDir, "types.go")], { stdio: "pipe" });
  execFileSync("gofmt", ["-w", path.join(goOutDir, "schemas.go")], { stdio: "pipe" });

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
