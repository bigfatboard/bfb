// ABOUTME: Validates and re-encodes BFB wire documents against embedded canonical JSON Schemas.
// ABOUTME: Maps Draft 2020-12 failures into deterministic diagnostics shared with TypeScript.

package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/qdis/bfb/internal/protocol/generated"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
)

var shellFields = map[string]struct{}{
	"command":           {},
	"executable":        {},
	"cwd":               {},
	"argv":              {},
	"shell":             {},
	"working_directory": {},
	"task_text":         {},
	"task_body":         {},
	"prompt":            {},
}

var compiledSchemas = compileSchemas()
var jsonNumberPattern = regexp.MustCompile(`^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$`)

const maximumWireInteger = "9007199254740991"
const maximumWireBytes = 1_048_576
const maximumStructuralItems = 4_096

var errWireComplexity = errors.New("wire JSON exceeds structural bounds")

// DecodeResult is the Go mirror of the TypeScript wire decode result.
type DecodeResult struct {
	OK    bool
	Value map[string]any
	JSON  string
	Error *generated.TypedError
}

type diagnosticCandidate struct {
	rank     int
	category string
	code     string
	message  string
	path     string
}

func typedError(category, code, message, path string) *generated.TypedError {
	err := &generated.TypedError{
		SchemaVersion: 1,
		Category:      category,
		Code:          code,
		Message:       message,
	}
	if path != "" && utf8.RuneCountInString(path) <= 256 {
		err.Path = &path
	}
	return err
}

func compileSchemas() map[string]*jsonschema.Schema {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	for _, resourceID := range generated.SchemaResourceIDs {
		source, ok := generated.SchemaResources[resourceID]
		if !ok {
			panic("protocol schema resource missing: " + resourceID)
		}
		value, err := decodeJSON([]byte(source))
		if err != nil {
			panic("protocol schema resource is invalid JSON: " + resourceID + ": " + err.Error())
		}
		if err := compiler.AddResource(resourceID, value); err != nil {
			panic("protocol schema resource cannot be registered: " + resourceID + ": " + err.Error())
		}
	}

	compiled := make(map[string]*jsonschema.Schema, len(generated.SchemaIDByDocument))
	for document, resourceID := range generated.SchemaIDByDocument {
		schema, err := compiler.Compile(resourceID)
		if err != nil {
			panic("protocol schema cannot be compiled: " + document + ": " + err.Error())
		}
		compiled[document] = schema
	}
	return compiled
}

func decodeJSON(input []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
}

func hasDuplicateObjectKey(input []byte) (bool, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	first, err := decoder.Token()
	if err != nil {
		return false, err
	}
	structuralItems := 0
	duplicate, err := scanJSONValue(decoder, first, 0, &structuralItems)
	if err != nil || duplicate {
		return duplicate, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return false, fmt.Errorf("multiple JSON values")
		}
		return false, err
	}
	return false, nil
}

func scanJSONValue(decoder *json.Decoder, token json.Token, depth int, structuralItems *int) (bool, error) {
	if depth > 256 {
		return false, errWireComplexity
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return false, nil
	}
	switch delimiter {
	case '{':
		keys := map[string]bool{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return false, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return false, fmt.Errorf("object key is not a string")
			}
			if keys[key] {
				return true, nil
			}
			keys[key] = true
			(*structuralItems)++
			if *structuralItems > maximumStructuralItems {
				return false, errWireComplexity
			}
			valueToken, err := decoder.Token()
			if err != nil {
				return false, err
			}
			duplicate, err := scanJSONValue(decoder, valueToken, depth+1, structuralItems)
			if err != nil || duplicate {
				return duplicate, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return false, fmt.Errorf("invalid object terminator")
		}
	case '[':
		for decoder.More() {
			(*structuralItems)++
			if *structuralItems > maximumStructuralItems {
				return false, errWireComplexity
			}
			valueToken, err := decoder.Token()
			if err != nil {
				return false, err
			}
			duplicate, err := scanJSONValue(decoder, valueToken, depth+1, structuralItems)
			if err != nil || duplicate {
				return duplicate, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return false, fmt.Errorf("invalid array terminator")
		}
	default:
		return false, fmt.Errorf("unexpected JSON delimiter")
	}
	return false, nil
}

func invalidUnicodeScalar(input []byte) bool {
	if !utf8.Valid(input) {
		return true
	}
	inString := false
	for index := 0; index < len(input); index++ {
		switch input[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(input) {
				continue
			}
			if input[index+1] != 'u' {
				index++
				continue
			}
			codepoint, ok := escapedCodepoint(input, index)
			if !ok {
				continue
			}
			if codepoint >= 0xD800 && codepoint <= 0xDBFF {
				if index+11 >= len(input) || input[index+6] != '\\' || input[index+7] != 'u' {
					return true
				}
				low, valid := escapedCodepoint(input, index+6)
				if !valid || low < 0xDC00 || low > 0xDFFF {
					return true
				}
				index += 11
				continue
			}
			if codepoint >= 0xDC00 && codepoint <= 0xDFFF {
				return true
			}
			index += 5
		}
	}
	return false
}

func escapedCodepoint(input []byte, slash int) (rune, bool) {
	if slash+5 >= len(input) || input[slash] != '\\' || input[slash+1] != 'u' {
		return 0, false
	}
	var value rune
	for _, digit := range input[slash+2 : slash+6] {
		value <<= 4
		switch {
		case digit >= '0' && digit <= '9':
			value += rune(digit - '0')
		case digit >= 'a' && digit <= 'f':
			value += rune(digit-'a') + 10
		case digit >= 'A' && digit <= 'F':
			value += rune(digit-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

func stableJSON(value any) (string, error) {
	normalized, err := normalize(value)
	if err != nil {
		return "", err
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(normalized); err != nil {
		return "", err
	}
	return strings.TrimSuffix(encoded.String(), "\n"), nil
}

func normalize(value any) (any, error) {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			nested, err := normalize(item)
			if err != nil {
				return nil, err
			}
			out[key] = nested
		}
		return out, nil
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			nested, err := normalize(item)
			if err != nil {
				return nil, err
			}
			out[index] = nested
		}
		return out, nil
	case json.Number:
		inspection := inspectNumber(typed.String())
		if inspection.failure == "" && inspection.integer != nil {
			return json.Number(*inspection.integer), nil
		}
		return typed, nil
	default:
		return value, nil
	}
}

type numericInspection struct {
	failure string
	integer *string
}

func inspectNumber(source string) numericInspection {
	match := jsonNumberPattern.FindStringSubmatch(source)
	if match == nil {
		return numericInspection{failure: "source_unavailable"}
	}
	negative := match[1] == "-"
	fraction := match[3]
	coefficient := strings.TrimLeft(match[2]+fraction, "0")
	if coefficient == "" {
		zero := "0"
		return numericInspection{integer: &zero}
	}
	exponentDigits := strings.TrimLeft(match[5], "0")
	if exponentDigits == "" {
		exponentDigits = "0"
	}
	if len(exponentDigits) > 9 {
		if match[4] == "-" {
			return numericInspection{failure: "fractional"}
		}
		outOfRange := "out_of_range"
		return numericInspection{failure: "unsafe", integer: &outOfRange}
	}
	exponentMagnitude, err := strconv.Atoi(exponentDigits)
	if err != nil {
		return numericInspection{failure: "source_unavailable"}
	}
	exponent := exponentMagnitude
	if match[4] == "-" {
		exponent = -exponent
	}
	decimalShift := exponent - len(fraction)
	integerDigits := ""
	if decimalShift >= 0 {
		if len(coefficient)+decimalShift > len(maximumWireInteger) {
			outOfRange := "out_of_range"
			return numericInspection{failure: "unsafe", integer: &outOfRange}
		}
		integerDigits = coefficient + strings.Repeat("0", decimalShift)
	} else {
		removedDigits := -decimalShift
		if removedDigits > len(coefficient) {
			return numericInspection{failure: "fractional"}
		}
		removed := coefficient[len(coefficient)-removedDigits:]
		if strings.Trim(removed, "0") != "" {
			return numericInspection{failure: "fractional"}
		}
		integerDigits = strings.TrimLeft(coefficient[:len(coefficient)-removedDigits], "0")
		if integerDigits == "" {
			integerDigits = "0"
		}
	}
	if len(integerDigits) > len(maximumWireInteger) ||
		(len(integerDigits) == len(maximumWireInteger) && integerDigits > maximumWireInteger) {
		outOfRange := "out_of_range"
		return numericInspection{failure: "unsafe", integer: &outOfRange}
	}
	if negative {
		integerDigits = "-" + integerDigits
	}
	return numericInspection{integer: &integerDigits}
}

func numericCandidates(value any, path string) []diagnosticCandidate {
	var candidates []diagnosticCandidate
	switch typed := value.(type) {
	case json.Number:
		inspection := inspectNumber(typed.String())
		switch inspection.failure {
		case "unsafe":
			candidates = append(candidates, diagnosticCandidate{30, "bound_exceeded", "maximum", "value exceeds schema bound", path})
		case "fractional", "source_unavailable":
			candidates = append(candidates, diagnosticCandidate{40, "type_mismatch", "type", "expected integer", path})
		}
	case map[string]any:
		for key, nested := range typed {
			candidates = append(candidates, numericCandidates(nested, path+"/"+escapePointer(key))...)
		}
	case []any:
		for index, nested := range typed {
			candidates = append(candidates, numericCandidates(nested, path+"/"+strconv.Itoa(index))...)
		}
	}
	return candidates
}

func asObject(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok
}

func preflightDiagnostic(document string, object map[string]any) *generated.TypedError {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, found := shellFields[key]; !found {
			continue
		}
		category := "shell_data"
		if document == "cloud-wake-intent" && key == "task_text" {
			category = "intent_confusion"
		}
		return typedError(category, "forbidden_shell_field", "wire document contains forbidden shell or task field", "/"+escapePointer(key))
	}

	if rawVersion, exists := object["schema_version"]; exists {
		if number, ok := rawVersion.(json.Number); ok {
			inspection := inspectNumber(number.String())
			if inspection.integer != nil && *inspection.integer != "1" {
				return typedError("unknown_version", "unsupported_schema_version", "unsupported schema_version", "/schema_version")
			}
		}
	}
	if rawKind, exists := object["kind"]; exists {
		if _, ok := rawKind.(string); !ok {
			return typedError("type_mismatch", "type", "event kind must be a string", "/kind")
		}
	}

	if document == "cloud-wake-intent" {
		if rawIntent, exists := object["intent_kind"]; exists {
			intent, ok := rawIntent.(string)
			if !ok {
				return typedError("type_mismatch", "type", "intent_kind must be a string", "/intent_kind")
			}
			if intent != "cloud_wake" {
				return typedError("intent_confusion", "wake_intent_kind_mismatch", "cloud wake intent requires intent_kind cloud_wake", "/intent_kind")
			}
		}
	}
	if document == "terminal-intent" {
		if rawIntent, exists := object["intent_kind"]; exists {
			intent, ok := rawIntent.(string)
			if !ok {
				return typedError("type_mismatch", "type", "intent_kind must be a string", "/intent_kind")
			}
			if intent != "terminal_local" {
				return typedError("intent_confusion", "terminal_intent_kind_mismatch", "terminal intent requires intent_kind terminal_local", "/intent_kind")
			}
		}
	}
	return nil
}

func categorizeValidation(document string, validationErr *jsonschema.ValidationError, numeric []diagnosticCandidate) *generated.TypedError {
	leaves := validationLeaves(validationErr)
	numericPaths := map[string]bool{}
	for _, candidate := range numeric {
		numericPaths[candidate.path] = true
	}
	candidates := make([]diagnosticCandidate, 0, len(leaves)+len(numeric))
	for _, leaf := range leaves {
		if numericPaths[pointer(leaf.InstanceLocation)] && isNumericValidationError(leaf) {
			continue
		}
		candidates = append(candidates, candidateFor(document, leaf))
	}
	candidates = append(candidates, numeric...)
	return diagnosticFromCandidates(candidates)
}

func isNumericValidationError(validationErr *jsonschema.ValidationError) bool {
	switch validationErr.ErrorKind.(type) {
	case *kind.Type, *kind.Minimum, *kind.Maximum, *kind.ExclusiveMinimum,
		*kind.ExclusiveMaximum, *kind.MultipleOf, *kind.Const, *kind.Enum:
		return true
	default:
		return false
	}
}

func diagnosticFromCandidates(candidates []diagnosticCandidate) *generated.TypedError {
	if len(candidates) == 0 {
		return typedError("schema_invalid", "schema_validation_failed", "document failed schema validation", "")
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].rank != candidates[right].rank {
			return candidates[left].rank < candidates[right].rank
		}
		if candidates[left].path != candidates[right].path {
			return candidates[left].path < candidates[right].path
		}
		return candidates[left].code < candidates[right].code
	})
	selected := candidates[0]
	return typedError(selected.category, selected.code, selected.message, selected.path)
}

func validationLeaves(validationErr *jsonschema.ValidationError) []*jsonschema.ValidationError {
	if len(validationErr.Causes) == 0 {
		return []*jsonschema.ValidationError{validationErr}
	}
	var leaves []*jsonschema.ValidationError
	for _, cause := range validationErr.Causes {
		leaves = append(leaves, validationLeaves(cause)...)
	}
	return leaves
}

func candidateFor(document string, validationErr *jsonschema.ValidationError) diagnosticCandidate {
	path := pointer(validationErr.InstanceLocation)
	keywordPath := validationErr.ErrorKind.KeywordPath()
	keyword := "schema_validation_failed"
	if len(keywordPath) > 0 {
		keyword = keywordPath[len(keywordPath)-1]
	}

	switch typed := validationErr.ErrorKind.(type) {
	case *kind.Required:
		missing := append([]string{}, typed.Missing...)
		sort.Strings(missing)
		if len(missing) > 0 {
			path += "/" + escapePointer(missing[0])
		}
		return diagnosticCandidate{10, "missing_field", "required_property", "missing required field", path}
	case *kind.AdditionalProperties:
		properties := append([]string{}, typed.Properties...)
		sort.Strings(properties)
		additional := ""
		if len(properties) > 0 {
			additional = properties[0]
			path += "/" + escapePointer(additional)
		}
		if _, shell := shellFields[additional]; shell {
			return diagnosticCandidate{20, "shell_data", "forbidden_shell_field", "wire document contains forbidden shell or task field", path}
		}
		if (document == "cloud-wake-intent" || document == "terminal-intent") && additional == "checkout_path" {
			return diagnosticCandidate{20, "intent_confusion", "intent_additional_field", "intent contains disallowed field", path}
		}
		return diagnosticCandidate{20, "additional_field", "additional_property", "unexpected additional field", path}
	case *kind.MaxLength, *kind.MinLength, *kind.MaxItems, *kind.MinItems,
		*kind.MaxProperties, *kind.MinProperties, *kind.Minimum, *kind.Maximum,
		*kind.ExclusiveMinimum, *kind.ExclusiveMaximum:
		return diagnosticCandidate{30, "bound_exceeded", schemaKeywordCode(keyword), "value exceeds schema bound", path}
	case *kind.Enum:
		if strings.HasSuffix(path, "/kind") {
			return diagnosticCandidate{5, "unknown_kind", "unknown_event_kind", "unknown event kind", path}
		}
		return diagnosticCandidate{40, "type_mismatch", "enum", "value is not an allowed enum member", path}
	case *kind.Type, *kind.Pattern, *kind.Format:
		return diagnosticCandidate{40, "type_mismatch", keyword, "value does not match schema type", path}
	case *kind.Const:
		if strings.HasSuffix(path, "/intent_kind") {
			return diagnosticCandidate{5, "intent_confusion", "intent_kind_const_mismatch", "intent_kind does not match document type", path}
		}
		return diagnosticCandidate{40, "type_mismatch", "const", "value does not match required constant", path}
	case *kind.UniqueItems:
		return diagnosticCandidate{50, "schema_invalid", "unique_items", "array items must be unique", path}
	default:
		return diagnosticCandidate{60, "schema_invalid", keyword, "document failed schema validation", path}
	}
}

func schemaKeywordCode(keyword string) string {
	var code strings.Builder
	for _, character := range keyword {
		if unicode.IsUpper(character) {
			code.WriteByte('_')
			code.WriteRune(unicode.ToLower(character))
			continue
		}
		code.WriteRune(character)
	}
	return code.String()
}

func pointer(parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	escaped := make([]string, len(parts))
	for index, part := range parts {
		escaped[index] = escapePointer(part)
	}
	return "/" + strings.Join(escaped, "/")
}

func escapePointer(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

// DecodeWireDocument validates a document against the generated schema registry.
func DecodeWireDocument(document string, input []byte) DecodeResult {
	schema, exists := compiledSchemas[document]
	if !exists {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "unknown_document", "unknown wire document name", "")}
	}
	if len(input) > maximumWireBytes {
		return DecodeResult{OK: false, Error: typedError("bound_exceeded", "max_bytes", "wire document exceeds the byte bound", "")}
	}
	if invalidUnicodeScalar(input) {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "invalid_unicode", "wire document contains an invalid Unicode scalar", "")}
	}
	trimmed := bytes.TrimLeft(input, " \t\r\n")
	if len(trimmed) > 0 && trimmed[0] == '[' {
		return DecodeResult{OK: false, Error: typedError("type_mismatch", "type", "wire document must be an object", "")}
	}
	duplicate, err := hasDuplicateObjectKey(input)
	if errors.Is(err, errWireComplexity) {
		return DecodeResult{OK: false, Error: typedError("bound_exceeded", "max_items", "wire document exceeds structural bounds", "")}
	}
	if err != nil {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "json_parse_failed", "input is not valid JSON", "")}
	}
	if duplicate {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "duplicate_key", "wire document contains a duplicate object key", "")}
	}
	value, err := decodeJSON(input)
	if err != nil {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "json_parse_failed", "input is not valid JSON", "")}
	}
	rawObject, rawIsObject := asObject(value)
	if rawIsObject {
		if diagnostic := preflightDiagnostic(document, rawObject); diagnostic != nil {
			return DecodeResult{OK: false, Error: diagnostic}
		}
	}
	numbers := numericCandidates(value, "")
	normalized, err := normalize(value)
	if err != nil {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "encode_failed", err.Error(), "")}
	}
	if err := schema.Validate(normalized); err != nil {
		validationErr, ok := err.(*jsonschema.ValidationError)
		if !ok {
			return DecodeResult{OK: false, Error: typedError("schema_invalid", "schema_validation_failed", "document failed schema validation", "")}
		}
		return DecodeResult{OK: false, Error: categorizeValidation(document, validationErr, numbers)}
	}
	if len(numbers) > 0 {
		return DecodeResult{OK: false, Error: diagnosticFromCandidates(numbers)}
	}
	object, isObject := asObject(normalized)
	if !isObject {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "schema_validation_failed", "document failed schema validation", "")}
	}
	encoded, err := stableJSON(object)
	if err != nil {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "encode_failed", err.Error(), "")}
	}
	return DecodeResult{OK: true, Value: object, JSON: encoded}
}

// LoadFixtureMatrix reads the shared Swift-consumable fixture matrix.
func LoadFixtureMatrix(repoRoot string) ([]byte, error) {
	return os.ReadFile(filepath.Join(repoRoot, "protocol", "fixtures", "v1", "matrix.json"))
}

// RepositoryRoot walks upward from cwd looking for go.mod.
func RepositoryRoot() (string, error) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		return "", err
	}
	directory := workingDirectory
	for {
		if _, err := os.Stat(filepath.Join(directory, "go.mod")); err == nil {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("go.mod not found from %s", workingDirectory)
		}
		directory = parent
	}
}

// FixturePath joins a matrix-relative fixture path.
func FixturePath(repoRoot, relative string) string {
	return filepath.Join(repoRoot, "protocol", "fixtures", "v1", filepath.FromSlash(relative))
}

// DocumentNames returns generated document names for smoke checks.
func DocumentNames() []string {
	return append([]string{}, generated.DocumentNames...)
}

// ProtocolHead returns the wire protocol head string.
func ProtocolHead() string {
	return generated.ProtocolHead
}

// NormalizeJSON re-encodes JSON with sorted object keys and canonical integers.
func NormalizeJSON(input []byte) (string, error) {
	value, err := decodeJSON(input)
	if err != nil {
		return "", err
	}
	return stableJSON(value)
}

// HasShellField reports whether a decoded object carries a forbidden shell field.
func HasShellField(object map[string]any) bool {
	for key := range object {
		if _, found := shellFields[key]; found {
			return true
		}
	}
	return false
}

// TrimSpace is a tiny helper used by tests to avoid unused-import churn in generated output.
func TrimSpace(value string) string {
	return strings.TrimSpace(value)
}
