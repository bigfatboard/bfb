// ABOUTME: Validates and re-encodes BFB wire documents against canonical JSON Schemas.
// ABOUTME: Maps schema failures into shared diagnostic categories for cross-language fixtures.

import type { TypedError, WireDocumentName } from "./generated/types.js";
import { WIRE_VALIDATORS } from "./generated/validators.js";

interface ErrorObject {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
  message?: string;
}

interface ValidateFunction {
  (value: unknown): boolean;
  errors?: ErrorObject[] | null;
}

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
const numericValidationKeywords = new Set([
  "type",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "const",
  "enum",
]);
const maximumWireInteger = "9007199254740991";
const maximumWireBytes = 1_048_576;
const maximumStructuralItems = 4_096;

type NumericFailure = "fractional" | "unsafe" | "source_unavailable";

interface NumericInspection {
  failure?: NumericFailure;
  integer?: string;
}

interface NumericObservation extends NumericInspection {
  holder: object;
  key: string;
  path?: string;
}

function exceedsMaximumInteger(digits: string): boolean {
  return (
    digits.length > maximumWireInteger.length ||
    (digits.length === maximumWireInteger.length && digits > maximumWireInteger)
  );
}

function numericSourceInspection(source: string): NumericInspection {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/u.exec(source);
  if (!match) {
    return { failure: "source_unavailable" };
  }
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  const coefficient = (match[2] + fraction).replace(/^0+/u, "");
  if (coefficient.length === 0) {
    return { integer: "0" };
  }

  const exponentDigits = (match[5] ?? "0").replace(/^0+/u, "") || "0";
  if (exponentDigits.length > 9) {
    return match[4] === "-"
      ? { failure: "fractional" }
      : { failure: "unsafe", integer: "out_of_range" };
  }
  const exponentMagnitude = Number(exponentDigits);
  const exponent = match[4] === "-" ? -exponentMagnitude : exponentMagnitude;
  const decimalShift = exponent - fraction.length;

  let integerDigits: string;
  if (decimalShift >= 0) {
    if (coefficient.length + decimalShift > maximumWireInteger.length) {
      return { failure: "unsafe", integer: "out_of_range" };
    }
    integerDigits = coefficient + "0".repeat(decimalShift);
  } else {
    const removedDigits = -decimalShift;
    if (removedDigits > coefficient.length) {
      return { failure: "fractional" };
    }
    const removed = coefficient.slice(coefficient.length - removedDigits);
    if (!/^0*$/u.test(removed)) {
      return { failure: "fractional" };
    }
    integerDigits = coefficient.slice(0, coefficient.length - removedDigits).replace(/^0+/u, "");
    if (integerDigits.length === 0) {
      integerDigits = "0";
    }
  }
  if (exceedsMaximumInteger(integerDigits)) {
    return { failure: "unsafe", integer: "out_of_range" };
  }
  return { integer: negative ? "-" + integerDigits : integerDigits };
}

function valueNumericFailure(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): NumericFailure | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      return "fractional";
    }
    return Number.isSafeInteger(value) ? undefined : "unsafe";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    for (const item of value) {
      const failure = valueNumericFailure(item, seen);
      if (failure) {
        return failure;
      }
    }
  } else if (value && typeof value === "object") {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    for (const item of Object.values(value)) {
      const failure = valueNumericFailure(item, seen);
      if (failure) {
        return failure;
      }
    }
  }
  return undefined;
}

function numericDiagnostic(failure: NumericFailure, path?: string): TypedError {
  if (failure === "unsafe") {
    const error: TypedError = {
      schema_version: 1,
      category: "bound_exceeded",
      code: "maximum",
      message: "value exceeds schema bound",
    };
    if (path) {
      error.path = path;
    }
    return error;
  }
  const error: TypedError = {
    schema_version: 1,
    category: "type_mismatch",
    code: "type",
    message: "expected integer",
  };
  if (path) {
    error.path = path;
  }
  return error;
}

function numericRank(failure: NumericFailure): number {
  return failure === "unsafe" ? 30 : 40;
}

function diagnosticRank(error: TypedError): number {
  switch (error.category) {
    case "unknown_version":
    case "intent_confusion":
      return 0;
    case "unknown_kind":
      return 5;
    case "missing_field":
      return 10;
    case "additional_field":
    case "shell_data":
      return 20;
    case "bound_exceeded":
      return 30;
    case "type_mismatch":
      return 40;
    case "schema_invalid":
    case "authoritative_runner_claim":
      return 50;
    case "operation_failed":
    case "authorization_denied":
    case "unavailable":
    case "conflict":
      return 60;
  }
}

function compareDiagnostics(
  left: { rank: number; error: TypedError },
  right: { rank: number; error: TypedError },
): number {
  return (
    left.rank - right.rank ||
    ordinalCompare(left.error.path ?? "", right.error.path ?? "") ||
    ordinalCompare(left.error.code, right.error.code)
  );
}

function bestNumericDiagnostic(
  observations: NumericObservation[],
): { rank: number; error: TypedError } | undefined {
  return observations
    .filter(
      (observation): observation is NumericObservation & { failure: NumericFailure } =>
        observation.failure !== undefined,
    )
    .map((observation) => ({
      rank: numericRank(observation.failure),
      error: numericDiagnostic(observation.failure, observation.path),
    }))
    .sort(compareDiagnostics)[0];
}

function boundedDiagnostic(error: TypedError): TypedError {
  if (error.path && Array.from(error.path).length > 256) {
    const { path: _path, ...withoutPath } = error;
    return withoutPath;
  }
  return error;
}

function containsInvalidUnicodeScalar(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          return true;
        }
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return value.some((nested) => containsInvalidUnicodeScalar(nested, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return Object.entries(value).some(
      ([key, nested]) =>
        containsInvalidUnicodeScalar(key, seen) || containsInvalidUnicodeScalar(nested, seen),
    );
  }
  return false;
}

function escapedCodepoint(source: string, slash: number): number | undefined {
  if (source[slash] !== "\\" || source[slash + 1] !== "u") {
    return undefined;
  }
  const digits = source.slice(slash + 2, slash + 6);
  if (!/^[0-9a-fA-F]{4}$/u.test(digits)) {
    return undefined;
  }
  return Number.parseInt(digits, 16);
}

function containsInvalidEscapedUnicodeScalar(source: string): boolean {
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '"') {
      inString = !inString;
      continue;
    }
    if (source[index] !== "\\" || !inString || index + 1 >= source.length) {
      continue;
    }
    if (source[index + 1] !== "u") {
      index += 1;
      continue;
    }
    const codepoint = escapedCodepoint(source, index);
    if (codepoint === undefined) {
      continue;
    }
    if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
      const low = escapedCodepoint(source, index + 6);
      if (low === undefined || low < 0xdc00 || low > 0xdfff) {
        return true;
      }
      index += 11;
      continue;
    }
    if (codepoint >= 0xdc00 && codepoint <= 0xdfff) {
      return true;
    }
    index += 5;
  }
  return false;
}

type StructuralFailure = "duplicate_key" | "complexity";

function scanJSONStructure(input: string): StructuralFailure | undefined {
  let index = 0;
  let structuralItems = 0;

  function skipWhitespace(): void {
    while (/[ \t\r\n]/u.test(input[index] ?? "")) {
      index += 1;
    }
  }

  function parseStringToken(): string | undefined {
    if (input[index] !== '"') {
      return undefined;
    }
    const start = index;
    index += 1;
    while (index < input.length) {
      if (input[index] === "\\") {
        index += 2;
        continue;
      }
      if (input[index] === '"') {
        index += 1;
        try {
          return JSON.parse(input.slice(start, index)) as string;
        } catch {
          return undefined;
        }
      }
      index += 1;
    }
    return undefined;
  }

  function scanValue(depth: number): StructuralFailure | undefined {
    if (depth > 256) {
      return "complexity";
    }
    skipWhitespace();
    if (input[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (input[index] === "}") {
        index += 1;
        return undefined;
      }
      while (index < input.length) {
        const key = parseStringToken();
        if (key === undefined) {
          return undefined;
        }
        if (keys.has(key)) {
          return "duplicate_key";
        }
        keys.add(key);
        structuralItems += 1;
        if (structuralItems > maximumStructuralItems) {
          return "complexity";
        }
        skipWhitespace();
        if (input[index] !== ":") {
          return undefined;
        }
        index += 1;
        const nestedFailure = scanValue(depth + 1);
        if (nestedFailure) {
          return nestedFailure;
        }
        skipWhitespace();
        if (input[index] === "}") {
          index += 1;
          return undefined;
        }
        if (input[index] !== ",") {
          return undefined;
        }
        index += 1;
        skipWhitespace();
      }
      return undefined;
    }
    if (input[index] === "[") {
      index += 1;
      skipWhitespace();
      if (input[index] === "]") {
        index += 1;
        return undefined;
      }
      while (index < input.length) {
        structuralItems += 1;
        if (structuralItems > maximumStructuralItems) {
          return "complexity";
        }
        const nestedFailure = scanValue(depth + 1);
        if (nestedFailure) {
          return nestedFailure;
        }
        skipWhitespace();
        if (input[index] === "]") {
          index += 1;
          return undefined;
        }
        if (input[index] !== ",") {
          return undefined;
        }
        index += 1;
      }
      return undefined;
    }
    if (input[index] === '"') {
      parseStringToken();
      return undefined;
    }
    while (index < input.length && !/[\s,\]}]/u.test(input[index] ?? "")) {
      index += 1;
    }
    return undefined;
  }

  return scanValue(0);
}

function ordinalCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    }
  }
  return leftPoints.length - rightPoints.length;
}

function assignNumericPaths(value: unknown, observations: NumericObservation[]): void {
  const paths = new WeakMap<object, string>();

  function visit(nested: unknown, path: string): void {
    if (!nested || typeof nested !== "object") {
      return;
    }
    paths.set(nested, path);
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => visit(item, path + "/" + String(index)));
      return;
    }
    for (const [key, item] of Object.entries(nested)) {
      visit(item, path + "/" + escapePointerToken(key));
    }
  }

  visit(value, "");
  for (const observation of observations) {
    const holderPath = paths.get(observation.holder);
    if (holderPath !== undefined) {
      observation.path = holderPath + "/" + escapePointerToken(observation.key);
    }
  }
}

function schemaKeywordCode(keyword: string): string {
  return keyword.replaceAll(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
}

function escapePointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function validationPriority(error: ErrorObject): number {
  if (
    (error.keyword === "enum" && error.instancePath.endsWith("/kind")) ||
    (error.keyword === "const" && error.instancePath.endsWith("/intent_kind"))
  ) {
    return 5;
  }
  if (error.keyword === "required") {
    return 10;
  }
  if (error.keyword === "additionalProperties") {
    return 20;
  }
  if (
    error.keyword === "maxLength" ||
    error.keyword === "minLength" ||
    error.keyword === "maxItems" ||
    error.keyword === "minItems" ||
    error.keyword === "maxProperties" ||
    error.keyword === "minProperties" ||
    error.keyword === "minimum" ||
    error.keyword === "maximum" ||
    error.keyword === "exclusiveMinimum" ||
    error.keyword === "exclusiveMaximum"
  ) {
    return 30;
  }
  if (
    error.keyword === "type" ||
    error.keyword === "enum" ||
    error.keyword === "const" ||
    error.keyword === "pattern" ||
    error.keyword === "format"
  ) {
    return 40;
  }
  if (error.keyword === "uniqueItems") {
    return 50;
  }
  return 60;
}

function validationPath(error: ErrorObject): string {
  if (error.keyword === "required") {
    return (
      error.instancePath +
      "/" +
      escapePointerToken(
        String((error.params as { missingProperty?: string }).missingProperty ?? ""),
      )
    );
  }
  if (error.keyword === "additionalProperties") {
    return (
      error.instancePath +
      "/" +
      escapePointerToken(
        String((error.params as { additionalProperty?: string }).additionalProperty ?? ""),
      )
    );
  }
  return error.instancePath;
}

const validators = WIRE_VALIDATORS as Record<WireDocumentName, ValidateFunction>;

function categorize(
  document: WireDocumentName,
  value: unknown,
  errors: ErrorObject[] | null | undefined,
  rootVersion?: NumericInspection,
): TypedError {
  const data = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

  if (data) {
    const forbiddenField = Object.keys(data)
      .filter((field) => shellFieldSet.has(field))
      .sort()[0];
    if (forbiddenField) {
      return {
        schema_version: 1,
        category:
          document === "cloud-wake-intent" && forbiddenField === "task_text"
            ? "intent_confusion"
            : "shell_data",
        code: "forbidden_shell_field",
        message: "wire document contains forbidden shell or task field",
        path: "/" + forbiddenField,
      };
    }
  }

  if (data && data.schema_version !== undefined) {
    if (rootVersion?.integer !== undefined && rootVersion.integer !== "1") {
      return {
        schema_version: 1,
        category: "unknown_version",
        code: "unsupported_schema_version",
        message: "unsupported schema_version",
        path: "/schema_version",
      };
    }
    const version = data.schema_version;
    if (!rootVersion && typeof version === "number" && Number.isInteger(version) && version !== 1) {
      return {
        schema_version: 1,
        category: "unknown_version",
        code: "unsupported_schema_version",
        message: "unsupported schema_version",
        path: "/schema_version",
      };
    }
  }

  if (data?.kind !== undefined && typeof data.kind !== "string") {
    return {
      schema_version: 1,
      category: "type_mismatch",
      code: "type",
      message: "event kind must be a string",
      path: "/kind",
    };
  }

  if (
    document === "cloud-wake-intent" &&
    data &&
    data.intent_kind !== undefined &&
    typeof data.intent_kind !== "string"
  ) {
    return {
      schema_version: 1,
      category: "type_mismatch",
      code: "type",
      message: "intent_kind must be a string",
      path: "/intent_kind",
    };
  }
  if (
    document === "terminal-intent" &&
    data &&
    data.intent_kind !== undefined &&
    typeof data.intent_kind !== "string"
  ) {
    return {
      schema_version: 1,
      category: "type_mismatch",
      code: "type",
      message: "intent_kind must be a string",
      path: "/intent_kind",
    };
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

  const orderedErrors = [...(errors ?? [])].sort((left, right) => {
    const priority = validationPriority(left) - validationPriority(right);
    if (priority !== 0) {
      return priority;
    }
    return (
      ordinalCompare(validationPath(left), validationPath(right)) ||
      ordinalCompare(left.keyword, right.keyword)
    );
  });

  for (const error of orderedErrors) {
    if (error.keyword === "enum" && error.instancePath.endsWith("/kind")) {
      return {
        schema_version: 1,
        category: "unknown_kind",
        code: "unknown_event_kind",
        message: "unknown event kind",
        path: error.instancePath || "/kind",
      };
    }
    if (error.keyword === "enum") {
      const enumError: TypedError = {
        schema_version: 1,
        category: "type_mismatch",
        code: "enum",
        message: "value is not an allowed enum member",
      };
      if (error.instancePath) {
        enumError.path = error.instancePath;
      }
      return enumError;
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
    if (error.keyword === "const") {
      return {
        schema_version: 1,
        category: "type_mismatch",
        code: "const",
        message: "value does not match required constant",
        ...(error.instancePath ? { path: error.instancePath } : {}),
      };
    }
    if (error.keyword === "uniqueItems") {
      const uniqueError: TypedError = {
        schema_version: 1,
        category: "schema_invalid",
        code: "unique_items",
        message: "array items must be unique",
      };
      if (error.instancePath) {
        uniqueError.path = error.instancePath;
      }
      return uniqueError;
    }
    if (
      error.keyword === "maxLength" ||
      error.keyword === "minLength" ||
      error.keyword === "maxItems" ||
      error.keyword === "minItems" ||
      error.keyword === "maxProperties" ||
      error.keyword === "minimum" ||
      error.keyword === "maximum" ||
      error.keyword === "exclusiveMinimum" ||
      error.keyword === "exclusiveMaximum"
    ) {
      const boundError: TypedError = {
        schema_version: 1,
        category: "bound_exceeded",
        code: schemaKeywordCode(error.keyword),
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
          escapePointerToken(
            String((error.params as { missingProperty?: string }).missingProperty ?? ""),
          ),
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
          path: error.instancePath + "/" + escapePointerToken(additional),
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
          path: error.instancePath + "/" + escapePointerToken(additional),
        };
      }
      return {
        schema_version: 1,
        category: "additional_field",
        code: "additional_property",
        message: "unexpected additional field",
        path: error.instancePath + "/" + escapePointerToken(additional),
      };
    }
    if (error.keyword === "type" || error.keyword === "pattern" || error.keyword === "format") {
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
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (_key, nested) => {
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const record = nested as Record<string, unknown>;
        const ordered: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort(ordinalCompare)) {
          ordered[key] = record[key];
        }
        return ordered;
      }
      return nested;
    });
  } catch {
    throw new Error("wire value is not JSON encodable");
  }
  if (encoded === undefined) {
    throw new Error("wire value is not JSON encodable");
  }
  return encoded.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function decodeWireDocument<T = unknown>(
  document: WireDocumentName,
  input: Uint8Array,
): DecodeResult<T> {
  if (input.byteLength > maximumWireBytes) {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "bound_exceeded",
        code: "max_bytes",
        message: "wire document exceeds the byte bound",
      },
    };
  }
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "schema_invalid",
        code: "json_parse_failed",
        message: "UTF-8 byte-order marks are not permitted",
      },
    };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "schema_invalid",
        code: "invalid_unicode",
        message: "wire document is not valid UTF-8",
      },
    };
  }
  if (containsInvalidEscapedUnicodeScalar(source)) {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "schema_invalid",
        code: "invalid_unicode",
        message: "wire document contains an invalid Unicode scalar",
      },
    };
  }
  if (source.match(/[^ \t\r\n]/u)?.[0] === "[") {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "type_mismatch",
        code: "type",
        message: "wire document must be an object",
      },
    };
  }
  let value: unknown;
  const numericObservations: NumericObservation[] = [];
  const structuralFailure = scanJSONStructure(source);
  if (structuralFailure === "duplicate_key") {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "schema_invalid",
        code: "duplicate_key",
        message: "wire document contains a duplicate object key",
      },
    };
  }
  if (structuralFailure === "complexity") {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "bound_exceeded",
        code: "max_items",
        message: "wire document exceeds structural bounds",
      },
    };
  }
  try {
    value = JSON.parse(
      source,
      function (this: object, key: string, nested: unknown, context?: { source?: string }) {
        if (typeof nested === "number") {
          numericObservations.push({
            holder: this,
            key,
            ...(context?.source
              ? numericSourceInspection(context.source)
              : { failure: "source_unavailable" as const }),
          });
        }
        return nested;
      },
    ) as unknown;
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

  if (containsInvalidUnicodeScalar(value)) {
    return {
      ok: false,
      error: {
        schema_version: 1,
        category: "schema_invalid",
        code: "invalid_unicode",
        message: "wire document contains an invalid Unicode scalar",
      },
    };
  }

  assignNumericPaths(value, numericObservations);

  const validate = validators[document];
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
  const rootVersion = numericObservations.find(
    (observation) => observation.holder === value && observation.key === "schema_version",
  );
  const numericWinner = bestNumericDiagnostic(numericObservations);
  if (!ok) {
    const numericPaths = new Set(
      numericObservations
        .filter((observation) => observation.failure && observation.path)
        .map((observation) => observation.path as string),
    );
    const schemaErrors = (validate.errors ?? []).filter(
      (error) =>
        !numericPaths.has(validationPath(error)) || !numericValidationKeywords.has(error.keyword),
    );
    const diagnostic = boundedDiagnostic(categorize(document, value, schemaErrors, rootVersion));
    const schemaCandidate = { rank: diagnosticRank(diagnostic), error: diagnostic };
    if (numericWinner && compareDiagnostics(numericWinner, schemaCandidate) < 0) {
      return { ok: false, error: boundedDiagnostic(numericWinner.error) };
    }
    return {
      ok: false,
      error: diagnostic,
    };
  }

  if (numericWinner) {
    return { ok: false, error: boundedDiagnostic(numericWinner.error) };
  }

  const json = stableStringify(value);
  return { ok: true, value: value as T, json };
}

export function encodeWireDocument(value: unknown): string {
  if (containsInvalidUnicodeScalar(value)) {
    throw new Error("wire document contains an invalid Unicode scalar");
  }
  const numericFailure = valueNumericFailure(value);
  if (numericFailure) {
    throw new Error(numericDiagnostic(numericFailure).message);
  }
  return stableStringify(value);
}
