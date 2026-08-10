// ABOUTME: Validates and re-encodes BFB wire documents against canonical JSON Schemas.
// ABOUTME: Maps schema failures into shared diagnostic categories for cross-language fixtures.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import type { TypedError, WireDocumentName } from "./generated/types.js";

export type DecodeResult<T> =
  { ok: true; value: T; json: string } | { ok: false; error: TypedError };

const SHELL_FIELDS = [
  "command",
  "executable",
  "cwd",
  "argv",
  "shell",
  "working_directory",
  "task_text",
  "task_body",
  "prompt",
] as const;

const shellFieldSet = new Set<string>(SHELL_FIELDS);

function schemaRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../protocol/schema/v1");
}

function loadSchemas(): { validators: Map<string, ValidateFunction> } {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateSchema: false,
  });

  const root = schemaRoot();
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const file of files) {
    const schema = JSON.parse(readFileSync(path.join(root, file), "utf8")) as object;
    ajv.addSchema(schema, file);
  }

  const validators = new Map<string, ValidateFunction>();
  const mapping: Array<[WireDocumentName, string]> = [
    ["event-envelope", "event-envelope.json"],
    ["event-disposition", "event-disposition.json"],
    ["runner-enrollment", "runner-enrollment.json"],
    ["checkout-summary", "checkout-summary.json"],
    ["execution-assignment", "execution-assignment.json"],
    ["launch-specification", "launch-specification.json"],
    ["launch-claim", "launch-claim.json"],
    ["final-authorization", "final-authorization.json"],
    ["cloud-wake-intent", "cloud-wake-intent.json"],
    ["terminal-intent", "terminal-intent.json"],
    ["local-rpc", "local-rpc.json"],
    ["runner-event-submission", "runner-event-submission.json"],
    ["typed-error", "typed-error.json"],
  ];
  for (const [name, file] of mapping) {
    const validate = ajv.getSchema(file);
    if (!validate) {
      throw new Error("missing compiled schema " + file);
    }
    validators.set(name, validate);
  }
  return { validators };
}

const { validators } = loadSchemas();

function categorize(
  document: WireDocumentName,
  value: unknown,
  errors: ErrorObject[] | null | undefined,
): TypedError {
  const data = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

  if (data) {
    for (const field of shellFieldSet) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        return {
          schema_version: 1,
          category: "shell_data",
          code: "forbidden_shell_field",
          message: "wire document contains forbidden shell or task field",
          path: "/" + field,
        };
      }
    }
  }

  if (
    document === "cloud-wake-intent" &&
    data &&
    data.intent_kind !== undefined &&
    data.intent_kind !== "cloud_wake"
  ) {
    return {
      schema_version: 1,
      category: "intent_confusion",
      code: "wake_intent_kind_mismatch",
      message: "cloud wake intent requires intent_kind cloud_wake",
      path: "/intent_kind",
    };
  }
  if (
    document === "terminal-intent" &&
    data &&
    data.intent_kind !== undefined &&
    data.intent_kind !== "terminal_local"
  ) {
    return {
      schema_version: 1,
      category: "intent_confusion",
      code: "terminal_intent_kind_mismatch",
      message: "terminal intent requires intent_kind terminal_local",
      path: "/intent_kind",
    };
  }
  if (
    (document === "cloud-wake-intent" || document === "terminal-intent") &&
    data &&
    (Object.prototype.hasOwnProperty.call(data, "task_text") ||
      Object.prototype.hasOwnProperty.call(data, "checkout_path") ||
      Object.prototype.hasOwnProperty.call(data, "executable") ||
      Object.prototype.hasOwnProperty.call(data, "argv"))
  ) {
    return {
      schema_version: 1,
      category: "intent_confusion",
      code: "intent_carries_execution_data",
      message: "intent must not carry task, checkout, or execution data",
    };
  }

  if (data && data.schema_version !== undefined && data.schema_version !== 1) {
    return {
      schema_version: 1,
      category: "unknown_version",
      code: "unsupported_schema_version",
      message: "unsupported schema_version",
      path: "/schema_version",
    };
  }

  for (const error of errors ?? []) {
    if (error.keyword === "enum" && error.instancePath.endsWith("/kind")) {
      return {
        schema_version: 1,
        category: "unknown_kind",
        code: "unknown_event_kind",
        message: "unknown event kind",
        path: error.instancePath || "/kind",
      };
    }
    if (error.keyword === "const" && error.instancePath.endsWith("/intent_kind")) {
      return {
        schema_version: 1,
        category: "intent_confusion",
        code: "intent_kind_const_mismatch",
        message: "intent_kind does not match document type",
        path: error.instancePath,
      };
    }
    if (
      error.keyword === "maxLength" ||
      error.keyword === "maxItems" ||
      error.keyword === "maxProperties"
    ) {
      const boundError: TypedError = {
        schema_version: 1,
        category: "bound_exceeded",
        code: error.keyword,
        message: "value exceeds schema bound",
      };
      if (error.instancePath) {
        boundError.path = error.instancePath;
      }
      return boundError;
    }
    if (error.keyword === "required") {
      return {
        schema_version: 1,
        category: "missing_field",
        code: "required_property",
        message: "missing required field",
        path:
          error.instancePath +
          "/" +
          String((error.params as { missingProperty?: string }).missingProperty ?? ""),
      };
    }
    if (error.keyword === "additionalProperties") {
      const additional = String(
        (error.params as { additionalProperty?: string }).additionalProperty ?? "",
      );
      if (shellFieldSet.has(additional)) {
        return {
          schema_version: 1,
          category: "shell_data",
          code: "forbidden_shell_field",
          message: "wire document contains forbidden shell or task field",
          path: error.instancePath + "/" + additional,
        };
      }
      if (
        (document === "cloud-wake-intent" || document === "terminal-intent") &&
        (additional === "task_text" ||
          additional === "checkout_path" ||
          additional === "executable" ||
          additional === "argv" ||
          additional === "command")
      ) {
        return {
          schema_version: 1,
          category:
            document === "cloud-wake-intent" && additional === "task_text"
              ? "intent_confusion"
              : shellFieldSet.has(additional) ||
                  additional === "executable" ||
                  additional === "argv" ||
                  additional === "command"
                ? "shell_data"
                : "intent_confusion",
          code: "intent_additional_field",
          message: "intent contains disallowed field",
          path: error.instancePath + "/" + additional,
        };
      }
      return {
        schema_version: 1,
        category: "additional_field",
        code: "additional_property",
        message: "unexpected additional field",
        path: error.instancePath + "/" + additional,
      };
    }
    if (error.keyword === "type" || error.keyword === "pattern") {
      const typeError: TypedError = {
        schema_version: 1,
        category: "type_mismatch",
        code: error.keyword,
        message: error.message ?? "type mismatch",
      };
      if (error.instancePath) {
        typeError.path = error.instancePath;
      }
      return typeError;
    }
  }

  return {
    schema_version: 1,
    category: "schema_invalid",
    code: "schema_validation_failed",
    message: "document failed schema validation",
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const record = nested as Record<string, unknown>;
      const ordered: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        ordered[key] = record[key];
      }
      return ordered;
    }
    return nested;
  });
}

export function decodeWireDocument<T = unknown>(
  document: WireDocumentName,
  input: string | unknown,
): DecodeResult<T> {
  let value: unknown;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return {
        ok: false,
        error: {
          schema_version: 1,
          category: "schema_invalid",
          code: "json_parse_failed",
          message: "input is not valid JSON",
        },
      };
    }
  } else {
    value = input;
  }

  // Pre-scan shell fields even if schema would also reject them
  if (value && typeof value === "object") {
    for (const field of shellFieldSet) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        const category =
          document === "cloud-wake-intent" && field === "task_text"
            ? "intent_confusion"
            : "shell_data";
        return {
          ok: false,
          error: {
            schema_version: 1,
            category,
            code: "forbidden_shell_field",
            message: "wire document contains forbidden shell or task field",
            path: "/" + field,
          },
        };
      }
    }
  }

  const validate = validators.get(document);
  if (!validate) {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "schema_invalid",
        code: "unknown_document",
        message: "unknown wire document name",
      },
    };
  }

  const ok = validate(value);
  if (!ok) {
    return { ok: false, error: categorize(document, value, validate.errors) };
  }

  const json = stableStringify(value);
  return { ok: true, value: value as T, json };
}

export function encodeWireDocument(value: unknown): string {
  return stableStringify(value);
}
