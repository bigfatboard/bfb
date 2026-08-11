// ABOUTME: Validates and re-encodes BFB wire fixtures for Go using shared diagnostic categories.
// ABOUTME: Mirrors TypeScript codec outcomes for the golden fixture matrix without a second schema language.

package protocol

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/qdis/bfb/internal/protocol/generated"
)

var (
	ulidPattern        = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
	utcPattern         = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$`)
	sha256Pattern      = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9._:~-]{8,128}$`)
	methodPattern      = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,63}$`)
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

// DecodeResult is the Go mirror of the TypeScript wire decode result.
type DecodeResult struct {
	OK    bool
	Value map[string]any
	JSON  string
	Error *generated.TypedError
}

func typedError(category, code, message, path string) *generated.TypedError {
	err := &generated.TypedError{
		SchemaVersion: 1,
		Category:      category,
		Code:          code,
		Message:       message,
	}
	if path != "" {
		err.Path = &path
	}
	return err
}

func stableJSON(value any) (string, error) {
	normalized, err := normalize(value)
	if err != nil {
		return "", err
	}
	bytes, err := json.Marshal(normalized)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

func normalize(value any) (any, error) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(typed))
		for _, key := range keys {
			nested, err := normalize(typed[key])
			if err != nil {
				return nil, err
			}
			out[key] = nested
		}
		return out, nil
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			nested, err := normalize(item)
			if err != nil {
				return nil, err
			}
			out[i] = nested
		}
		return out, nil
	default:
		return value, nil
	}
}

func asObject(value any) (map[string]any, bool) {
	obj, ok := value.(map[string]any)
	return obj, ok
}

func requireString(obj map[string]any, key string) (string, *generated.TypedError) {
	raw, ok := obj[key]
	if !ok {
		return "", typedError("missing_field", "required_property", "missing required field", "/"+key)
	}
	text, ok := raw.(string)
	if !ok {
		return "", typedError("type_mismatch", "type", "expected string", "/"+key)
	}
	return text, nil
}

func asInteger(raw any, path string) (int64, *generated.TypedError) {
	switch typed := raw.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed != math.Trunc(typed) {
			return 0, typedError("type_mismatch", "type", "expected integer", path)
		}
		// Reject values outside safe integer range used by wire primitives.
		if typed < 1 && typed != 0 {
			// still allow reading; bounds checked by caller
		}
		if typed > float64(9007199254740991) || typed < float64(-9007199254740991) {
			return 0, typedError("bound_exceeded", "maximum", "value exceeds schema bound", path)
		}
		return int64(typed), nil
	case json.Number:
		n, err := typed.Int64()
		if err != nil {
			return 0, typedError("type_mismatch", "type", "expected integer", path)
		}
		return n, nil
	case int:
		return int64(typed), nil
	case int64:
		return typed, nil
	default:
		return 0, typedError("type_mismatch", "type", "expected integer", path)
	}
}

func requireInt(obj map[string]any, key string) (int64, *generated.TypedError) {
	raw, ok := obj[key]
	if !ok {
		return 0, typedError("missing_field", "required_property", "missing required field", "/"+key)
	}
	return asInteger(raw, "/"+key)
}

func requireBoundedInt(obj map[string]any, key string, min, max int64) (int64, *generated.TypedError) {
	n, err := requireInt(obj, key)
	if err != nil {
		return 0, err
	}
	if n < min || n > max {
		code := "minimum"
		if n > max {
			code = "maximum"
		}
		return 0, typedError("bound_exceeded", code, "value exceeds schema bound", "/"+key)
	}
	return n, nil
}

func requireEnum(obj map[string]any, key string, allowedValues map[string]bool) (string, *generated.TypedError) {
	text, err := requireString(obj, key)
	if err != nil {
		return "", err
	}
	if !allowedValues[text] {
		return "", typedError("type_mismatch", "enum", "value is not an allowed enum member", "/"+key)
	}
	return text, nil
}

func requireUniqueStringSlice(raw any, path string, maxItems int, itemPattern *regexp.Regexp) *generated.TypedError {
	items, ok := raw.([]any)
	if !ok {
		return typedError("type_mismatch", "type", "expected array", path)
	}
	if maxItems > 0 && len(items) > maxItems {
		return typedError("bound_exceeded", "maxItems", "value exceeds schema bound", path)
	}
	seen := make(map[string]struct{}, len(items))
	for i, item := range items {
		text, ok := item.(string)
		if !ok {
			return typedError("type_mismatch", "type", "expected string", fmt.Sprintf("%s/%d", path, i))
		}
		if itemPattern != nil && !itemPattern.MatchString(text) {
			return typedError("type_mismatch", "pattern", "invalid array item", fmt.Sprintf("%s/%d", path, i))
		}
		if _, exists := seen[text]; exists {
			return typedError("schema_invalid", "uniqueItems", "array items must be unique", path)
		}
		seen[text] = struct{}{}
	}
	return nil
}

func requireUniqueULIDSlice(raw any, path string, maxItems int) *generated.TypedError {
	return requireUniqueStringSlice(raw, path, maxItems, ulidPattern)
}

var (
	principalTypes = map[string]bool{
		"human": true, "runner": true, "agent_run": true, "integration": true, "system": true,
	}
	sourceTypes = map[string]bool{
		"runner": true, "web": true, "mcp": true, "cli": true, "system": true, "integration": true,
	}
	providerNames = map[string]bool{
		"claude": true, "codex": true, "grok": true,
	}
	capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,63}$`)
)

func validatePrincipalRef(raw any, path string) *generated.TypedError {
	obj, ok := asObject(raw)
	if !ok {
		return typedError("missing_field", "required_property", "missing required field", path)
	}
	if err := checkAdditional(obj, allowed("type", "id"), "principal-ref"); err != nil {
		// rewrite path prefix for nested diagnostics
		if err.Path != nil {
			nested := path + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, err := requireEnum(obj, "type", principalTypes); err != nil {
		if err.Path != nil {
			nested := path + *err.Path
			err.Path = &nested
		}
		return err
	}
	if err := requireULID(obj, "id"); err != nil {
		if err.Path != nil {
			nested := path + *err.Path
			err.Path = &nested
		}
		return err
	}
	return nil
}

func validateSourceRef(raw any, path string) *generated.TypedError {
	obj, ok := asObject(raw)
	if !ok {
		return typedError("missing_field", "required_property", "missing required field", path)
	}
	if err := checkAdditional(obj, allowed("type", "id", "provider"), "source-ref"); err != nil {
		if err.Path != nil {
			nested := path + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, err := requireEnum(obj, "type", sourceTypes); err != nil {
		if err.Path != nil {
			nested := path + *err.Path
			err.Path = &nested
		}
		return err
	}
	if err := requireULID(obj, "id"); err != nil {
		if err.Path != nil {
			nested := path + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, has := obj["provider"]; has {
		if _, err := requireEnum(obj, "provider", providerNames); err != nil {
			if err.Path != nil {
				nested := path + *err.Path
				err.Path = &nested
			}
			return err
		}
	}
	return nil
}

func requireULID(obj map[string]any, key string) *generated.TypedError {
	text, err := requireString(obj, key)
	if err != nil {
		return err
	}
	if !ulidPattern.MatchString(text) {
		return typedError("type_mismatch", "pattern", "invalid ULID", "/"+key)
	}
	return nil
}

func requireUTC(obj map[string]any, key string) *generated.TypedError {
	text, err := requireString(obj, key)
	if err != nil {
		return err
	}
	if !utcPattern.MatchString(text) {
		return typedError("type_mismatch", "pattern", "invalid UTC timestamp", "/"+key)
	}
	return nil
}

func checkShellFields(obj map[string]any, document string) *generated.TypedError {
	for key := range obj {
		if _, found := shellFields[key]; found {
			category := "shell_data"
			if document == "cloud-wake-intent" && key == "task_text" {
				category = "intent_confusion"
			}
			return typedError(category, "forbidden_shell_field", "wire document contains forbidden shell or task field", "/"+key)
		}
	}
	return nil
}

func checkAdditional(obj map[string]any, allowed map[string]struct{}, document string) *generated.TypedError {
	for key := range obj {
		if _, ok := allowed[key]; ok {
			continue
		}
		if _, found := shellFields[key]; found {
			category := "shell_data"
			if document == "cloud-wake-intent" && key == "task_text" {
				category = "intent_confusion"
			}
			return typedError(category, "forbidden_shell_field", "wire document contains forbidden shell or task field", "/"+key)
		}
		if document == "cloud-wake-intent" || document == "terminal-intent" {
			return typedError("intent_confusion", "intent_additional_field", "intent contains disallowed field", "/"+key)
		}
		return typedError("additional_field", "additional_property", "unexpected additional field", "/"+key)
	}
	return nil
}

func requireSchemaVersion(obj map[string]any) *generated.TypedError {
	version, err := requireInt(obj, "schema_version")
	if err != nil {
		return err
	}
	if version != 1 {
		return typedError("unknown_version", "unsupported_schema_version", "unsupported schema_version", "/schema_version")
	}
	return nil
}

func allowed(keys ...string) map[string]struct{} {
	out := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		out[key] = struct{}{}
	}
	return out
}

// DecodeWireDocument validates a wire document name against the shared fixture rules.
func DecodeWireDocument(document string, input []byte) DecodeResult {
	var value any
	if err := json.Unmarshal(input, &value); err != nil {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "json_parse_failed", "input is not valid JSON", "")}
	}
	obj, ok := asObject(value)
	if !ok {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "schema_validation_failed", "document failed schema validation", "")}
	}
	if err := checkShellFields(obj, document); err != nil {
		return DecodeResult{OK: false, Error: err}
	}
	if err := validateDocument(document, obj); err != nil {
		return DecodeResult{OK: false, Error: err}
	}
	encoded, encodeErr := stableJSON(obj)
	if encodeErr != nil {
		return DecodeResult{OK: false, Error: typedError("schema_invalid", "encode_failed", encodeErr.Error(), "")}
	}
	return DecodeResult{OK: true, Value: obj, JSON: encoded}
}

func validateDocument(document string, obj map[string]any) *generated.TypedError {
	switch document {
	case "event-envelope":
		return validateEventEnvelope(obj)
	case "event-disposition":
		return validateEventDisposition(obj)
	case "runner-enrollment":
		return validateRunnerEnrollment(obj)
	case "checkout-summary":
		return validateCheckoutSummary(obj)
	case "execution-assignment":
		return validateExecutionAssignment(obj)
	case "launch-specification":
		return validateLaunchSpecification(obj)
	case "launch-claim":
		return validateLaunchClaim(obj)
	case "final-authorization":
		return validateFinalAuthorization(obj)
	case "cloud-wake-intent":
		return validateCloudWakeIntent(obj)
	case "terminal-intent":
		return validateTerminalIntent(obj)
	case "local-rpc":
		return validateLocalRPC(obj)
	case "runner-event-submission":
		return validateRunnerEventSubmission(obj)
	case "typed-error":
		return validateTypedError(obj)
	default:
		return typedError("schema_invalid", "unknown_document", "unknown wire document name", "")
	}
}

func validateEventEnvelope(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "event_id", "workspace_cursor", "source_stream_id", "source_event_id",
		"source_sequence", "workspace_id", "project_id", "task_id", "run_id", "run_execution_id",
		"assignment_generation", "provider_session_id", "actor", "source", "kind", "occurred_at",
		"received_at", "payload",
	), "event-envelope"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	for _, key := range []string{"event_id", "source_stream_id", "workspace_id"} {
		if err := requireULID(obj, key); err != nil {
			return err
		}
	}
	if _, err := requireBoundedInt(obj, "workspace_cursor", 1, 9007199254740991); err != nil {
		return err
	}
	if _, err := requireBoundedInt(obj, "source_sequence", 1, 9007199254740991); err != nil {
		return err
	}
	if _, has := obj["assignment_generation"]; has {
		if _, err := requireBoundedInt(obj, "assignment_generation", 1, 9007199254740991); err != nil {
			return err
		}
	}
	kind, err := requireString(obj, "kind")
	if err != nil {
		return err
	}
	if !eventKinds[kind] {
		return typedError("unknown_kind", "unknown_event_kind", "unknown event kind", "/kind")
	}
	if err := requireUTC(obj, "occurred_at"); err != nil {
		return err
	}
	if err := requireUTC(obj, "received_at"); err != nil {
		return err
	}
	if err := validatePrincipalRef(obj["actor"], "/actor"); err != nil {
		return err
	}
	if err := validateSourceRef(obj["source"], "/source"); err != nil {
		return err
	}
	for _, key := range []string{"project_id", "task_id", "run_id", "run_execution_id"} {
		if _, has := obj[key]; has {
			if err := requireULID(obj, key); err != nil {
				return err
			}
		}
	}
	if raw, has := obj["source_event_id"]; has {
		text, ok := raw.(string)
		if !ok {
			return typedError("type_mismatch", "type", "expected string", "/source_event_id")
		}
		if len(text) < 1 || len(text) > 256 {
			return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/source_event_id")
		}
	}
	if raw, has := obj["provider_session_id"]; has {
		text, ok := raw.(string)
		if !ok {
			return typedError("type_mismatch", "type", "expected string", "/provider_session_id")
		}
		if len(text) < 1 || len(text) > 256 {
			return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/provider_session_id")
		}
	}
	payload, ok := asObject(obj["payload"])
	if !ok {
		return typedError("missing_field", "required_property", "missing required field", "/payload")
	}
	if len(payload) > 0 {
		return typedError("additional_field", "additional_property", "unexpected additional field", "/payload")
	}
	return nil
}

var eventKinds = map[string]bool{
	"launch_requested": true, "launch_claimed": true, "launch_blocked": true, "launch_expired": true,
	"execution_attached": true, "execution_detached": true, "execution_ended": true,
	"session_started": true, "session_resumed": true, "session_ended": true,
	"turn_started": true, "turn_stopped": true, "turn_failed": true,
	"tool_started": true, "tool_finished": true, "tool_failed": true,
	"progress_reported": true, "attention_requested": true, "attention_resolved": true,
	"subagent_started": true, "subagent_ended": true, "context_compacted": true,
	"artifact_published": true, "result_submitted": true, "result_outdated": true, "result_accepted": true,
	"run_failed": true, "run_cancelled": true, "heartbeat": true,
}

func validateEventDisposition(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed("schema_version", "event_id", "source_stream_id", "source_sequence", "disposition", "diagnostic"), "event-disposition"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	if err := requireULID(obj, "event_id"); err != nil {
		return err
	}
	if err := requireULID(obj, "source_stream_id"); err != nil {
		return err
	}
	if _, err := requireBoundedInt(obj, "source_sequence", 1, 9007199254740991); err != nil {
		return err
	}
	if _, err := requireEnum(obj, "disposition", map[string]bool{
		"accepted": true, "already_committed": true, "retryable": true, "permanently_rejected": true,
	}); err != nil {
		return err
	}
	return nil
}

func validateRunnerEnrollment(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "runner_id", "workspace_id", "owner_human_id", "device_label",
		"public_key_thumbprint", "authorization_epoch", "status", "enrolled_at", "last_seen_at", "granted_project_ids",
	), "runner-enrollment"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	for _, key := range []string{"runner_id", "workspace_id", "owner_human_id"} {
		if err := requireULID(obj, key); err != nil {
			return err
		}
	}
	label, err := requireString(obj, "device_label")
	if err != nil {
		return err
	}
	if len(label) < 1 || len(label) > 128 {
		return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/device_label")
	}
	thumb, err := requireString(obj, "public_key_thumbprint")
	if err != nil {
		return err
	}
	if !sha256Pattern.MatchString(thumb) {
		return typedError("type_mismatch", "pattern", "invalid digest", "/public_key_thumbprint")
	}
	if _, err := requireBoundedInt(obj, "authorization_epoch", 1, 9007199254740991); err != nil {
		return err
	}
	if _, err := requireEnum(obj, "status", map[string]bool{
		"enrolled": true, "online": true, "offline": true, "revoked": true,
	}); err != nil {
		return err
	}
	if err := requireUTC(obj, "enrolled_at"); err != nil {
		return err
	}
	if raw, has := obj["granted_project_ids"]; has {
		if err := requireUniqueULIDSlice(raw, "/granted_project_ids", 64); err != nil {
			return err
		}
	}
	return nil
}

func validateCheckoutSummary(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "checkout_id", "runner_id", "project_id", "repository_identity",
		"workspace_subpath", "status", "validated_at",
	), "checkout-summary"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	for _, key := range []string{"checkout_id", "runner_id", "project_id"} {
		if err := requireULID(obj, key); err != nil {
			return err
		}
	}
	identity, err := requireString(obj, "repository_identity")
	if err != nil {
		return err
	}
	if len(identity) < 1 || len(identity) > 512 {
		return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/repository_identity")
	}
	if raw, has := obj["workspace_subpath"]; has {
		text, ok := raw.(string)
		if !ok {
			return typedError("type_mismatch", "type", "expected string", "/workspace_subpath")
		}
		if len(text) < 1 || len(text) > 512 {
			return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/workspace_subpath")
		}
	}
	if _, err := requireEnum(obj, "status", map[string]bool{
		"registered": true, "validated": true, "stale": true, "blocked": true,
	}); err != nil {
		return err
	}
	return requireUTC(obj, "validated_at")
}

func validateExecutionAssignment(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "run_execution_id", "assignment_generation", "runner_id", "run_id",
		"task_id", "project_id", "workspace_id", "checkout_id", "created_at", "ended_at",
	), "execution-assignment"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	for _, key := range []string{"run_execution_id", "runner_id", "run_id", "task_id", "project_id", "workspace_id", "checkout_id"} {
		if err := requireULID(obj, key); err != nil {
			return err
		}
	}
	if _, err := requireBoundedInt(obj, "assignment_generation", 1, 9007199254740991); err != nil {
		return err
	}
	return requireUTC(obj, "created_at")
}

func validateLaunchSpecification(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "launch_id", "run_id", "run_execution_id", "assignment_generation",
		"task_id", "runner_id", "checkout_id", "agent_profile_id", "config_snapshot_id",
		"config_snapshot_hash", "execution_config", "expires_at",
	), "launch-specification"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	for _, key := range []string{"launch_id", "run_id", "run_execution_id", "task_id", "runner_id", "checkout_id", "agent_profile_id", "config_snapshot_id"} {
		if err := requireULID(obj, key); err != nil {
			return err
		}
	}
	if _, err := requireBoundedInt(obj, "assignment_generation", 1, 9007199254740991); err != nil {
		return err
	}
	hash, err := requireString(obj, "config_snapshot_hash")
	if err != nil {
		return err
	}
	if !sha256Pattern.MatchString(hash) {
		return typedError("type_mismatch", "pattern", "invalid digest", "/config_snapshot_hash")
	}
	cfg, ok := asObject(obj["execution_config"])
	if !ok {
		return typedError("missing_field", "required_property", "missing required field", "/execution_config")
	}
	if err := checkAdditional(cfg, allowed(
		"provider", "mode", "model", "effort", "approval_policy", "filesystem_policy",
		"context_injection", "initial_turn_transport", "required_capabilities",
	), "launch-specification"); err != nil {
		return err
	}
	for _, key := range []string{
		"provider", "mode", "model", "effort", "approval_policy", "filesystem_policy",
		"context_injection", "initial_turn_transport", "required_capabilities",
	} {
		if _, has := cfg[key]; !has {
			return typedError("missing_field", "required_property", "missing required field", "/execution_config/"+key)
		}
	}
	if _, err := requireEnum(cfg, "provider", providerNames); err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, err := requireEnum(cfg, "mode", map[string]bool{"interactive": true, "headless": true}); err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	model, err := requireString(cfg, "model")
	if err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	if len(model) < 1 || len(model) > 128 {
		return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/execution_config/model")
	}
	if _, err := requireEnum(cfg, "effort", map[string]bool{"low": true, "medium": true, "high": true}); err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, err := requireEnum(cfg, "approval_policy", map[string]bool{"never": true, "on_request": true, "always": true}); err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, err := requireEnum(cfg, "filesystem_policy", map[string]bool{"read_only": true, "workspace_write": true}); err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, err := requireEnum(cfg, "context_injection", map[string]bool{"session_start_additional_context": true, "none": true}); err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	if _, err := requireEnum(cfg, "initial_turn_transport", map[string]bool{
		"provider_prompt": true, "waiting_user_submit": true, "none": true,
	}); err != nil {
		if err.Path != nil {
			nested := "/execution_config" + *err.Path
			err.Path = &nested
		}
		return err
	}
	caps, ok := cfg["required_capabilities"].([]any)
	if !ok {
		return typedError("type_mismatch", "type", "expected array", "/execution_config/required_capabilities")
	}
	if len(caps) < 1 {
		return typedError("bound_exceeded", "minItems", "value exceeds schema bound", "/execution_config/required_capabilities")
	}
	if err := requireUniqueStringSlice(caps, "/execution_config/required_capabilities", 32, capabilityPattern); err != nil {
		return err
	}
	return requireUTC(obj, "expires_at")
}

func validateLaunchClaim(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed("schema_version", "launch_id", "runner_id", "idempotency_key", "claimed_at", "device_proof_nonce"), "launch-claim"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	if err := requireULID(obj, "launch_id"); err != nil {
		return err
	}
	if err := requireULID(obj, "runner_id"); err != nil {
		return err
	}
	key, err := requireString(obj, "idempotency_key")
	if err != nil {
		return err
	}
	if !idempotencyPattern.MatchString(key) {
		return typedError("type_mismatch", "pattern", "invalid idempotency key", "/idempotency_key")
	}
	return requireUTC(obj, "claimed_at")
}

func validateFinalAuthorization(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "launch_id", "run_execution_id", "assignment_generation", "decision", "authorized_at", "rejection",
	), "final-authorization"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	if err := requireULID(obj, "launch_id"); err != nil {
		return err
	}
	if err := requireULID(obj, "run_execution_id"); err != nil {
		return err
	}
	if _, err := requireBoundedInt(obj, "assignment_generation", 1, 9007199254740991); err != nil {
		return err
	}
	if _, err := requireEnum(obj, "decision", map[string]bool{"authorized": true, "rejected": true}); err != nil {
		return err
	}
	return requireUTC(obj, "authorized_at")
}

func validateCloudWakeIntent(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "intent_kind", "intent_id", "workspace_id", "runner_id", "requesting_human_id", "launch_id", "expires_at",
	), "cloud-wake-intent"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	kind, err := requireString(obj, "intent_kind")
	if err != nil {
		return err
	}
	if kind != "cloud_wake" {
		return typedError("intent_confusion", "wake_intent_kind_mismatch", "cloud wake intent requires intent_kind cloud_wake", "/intent_kind")
	}
	for _, key := range []string{"intent_id", "workspace_id", "runner_id", "requesting_human_id"} {
		if err := requireULID(obj, key); err != nil {
			return err
		}
	}
	return requireUTC(obj, "expires_at")
}

func validateTerminalIntent(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "intent_kind", "local_intent_id", "launch_id", "created_at", "expires_at",
	), "terminal-intent"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	kind, err := requireString(obj, "intent_kind")
	if err != nil {
		return err
	}
	if kind != "terminal_local" {
		return typedError("intent_confusion", "terminal_intent_kind_mismatch", "terminal intent requires intent_kind terminal_local", "/intent_kind")
	}
	if err := requireULID(obj, "local_intent_id"); err != nil {
		return err
	}
	if err := requireULID(obj, "launch_id"); err != nil {
		return err
	}
	if err := requireUTC(obj, "created_at"); err != nil {
		return err
	}
	return requireUTC(obj, "expires_at")
}

func validateLocalRPC(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "request_id", "method", "direction", "idempotency_key", "error", "payload",
	), "local-rpc"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	if err := requireULID(obj, "request_id"); err != nil {
		return err
	}
	method, err := requireString(obj, "method")
	if err != nil {
		return err
	}
	if len(method) > 64 {
		return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/method")
	}
	if !methodPattern.MatchString(method) {
		return typedError("type_mismatch", "pattern", "invalid method", "/method")
	}
	if _, err := requireEnum(obj, "direction", map[string]bool{
		"request": true, "response": true, "event": true,
	}); err != nil {
		return err
	}
	return nil
}

var runnerEventKinds = map[string]bool{
	"launch_claimed": true, "execution_attached": true, "execution_detached": true, "execution_ended": true,
	"session_started": true, "session_resumed": true, "session_ended": true,
	"turn_started": true, "turn_stopped": true, "turn_failed": true,
	"tool_started": true, "tool_finished": true, "tool_failed": true,
	"progress_reported": true, "attention_requested": true,
	"subagent_started": true, "subagent_ended": true, "context_compacted": true,
	"artifact_published": true, "result_submitted": true,
	"run_failed": true, "run_cancelled": true, "heartbeat": true,
}

func validateRunnerEventSubmission(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed(
		"schema_version", "event_id", "source_stream_id", "source_sequence", "source_event_id",
		"run_execution_id", "assignment_generation", "claimed_workspace_id", "claimed_project_id",
		"claimed_task_id", "claimed_run_id", "provider_session_id", "kind", "occurred_at",
		"capture_origin", "payload",
	), "runner-event-submission"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	for _, key := range []string{"event_id", "source_stream_id", "run_execution_id"} {
		if err := requireULID(obj, key); err != nil {
			return err
		}
	}
	if _, err := requireBoundedInt(obj, "source_sequence", 1, 9007199254740991); err != nil {
		return err
	}
	if _, err := requireBoundedInt(obj, "assignment_generation", 1, 9007199254740991); err != nil {
		return err
	}
	for _, key := range []string{"claimed_workspace_id", "claimed_project_id", "claimed_task_id", "claimed_run_id"} {
		if _, has := obj[key]; has {
			if err := requireULID(obj, key); err != nil {
				return err
			}
		}
	}
	if raw, has := obj["source_event_id"]; has {
		text, ok := raw.(string)
		if !ok {
			return typedError("type_mismatch", "type", "expected string", "/source_event_id")
		}
		if len(text) < 1 || len(text) > 256 {
			return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/source_event_id")
		}
	}
	if raw, has := obj["provider_session_id"]; has {
		text, ok := raw.(string)
		if !ok {
			return typedError("type_mismatch", "type", "expected string", "/provider_session_id")
		}
		if len(text) < 1 || len(text) > 256 {
			return typedError("bound_exceeded", "maxLength", "value exceeds schema bound", "/provider_session_id")
		}
	}
	kind, err := requireString(obj, "kind")
	if err != nil {
		return err
	}
	if !runnerEventKinds[kind] {
		return typedError("unknown_kind", "unknown_event_kind", "unknown event kind", "/kind")
	}
	if err := requireUTC(obj, "occurred_at"); err != nil {
		return err
	}
	if _, err := requireEnum(obj, "capture_origin", map[string]bool{
		"runner_observed": true, "agent_reported": true, "hook_inbox": true,
	}); err != nil {
		return err
	}
	payload, ok := asObject(obj["payload"])
	if !ok {
		return typedError("missing_field", "required_property", "missing required field", "/payload")
	}
	if len(payload) > 0 {
		return typedError("additional_field", "additional_property", "unexpected additional field", "/payload")
	}
	return nil
}

func validateTypedError(obj map[string]any) *generated.TypedError {
	if err := checkAdditional(obj, allowed("schema_version", "category", "code", "message", "path"), "typed-error"); err != nil {
		return err
	}
	if err := requireSchemaVersion(obj); err != nil {
		return err
	}
	if _, err := requireString(obj, "category"); err != nil {
		return err
	}
	if _, err := requireString(obj, "code"); err != nil {
		return err
	}
	if _, err := requireString(obj, "message"); err != nil {
		return err
	}
	return nil
}

// LoadFixtureMatrix reads the shared Swift-consumable fixture matrix.
func LoadFixtureMatrix(repoRoot string) ([]byte, error) {
	return os.ReadFile(filepath.Join(repoRoot, "protocol", "fixtures", "v1", "matrix.json"))
}

// RepositoryRoot walks upward from cwd looking for go.mod.
func RepositoryRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.mod not found from %s", wd)
		}
		dir = parent
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

// NormalizeJSON re-encodes JSON with sorted object keys.
func NormalizeJSON(input []byte) (string, error) {
	var value any
	if err := json.Unmarshal(input, &value); err != nil {
		return "", err
	}
	return stableJSON(value)
}

// HasShellField reports whether a decoded object carries a forbidden shell field.
func HasShellField(obj map[string]any) bool {
	for key := range obj {
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
