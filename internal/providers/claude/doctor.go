// ABOUTME: Diagnoses Claude installation, version, hook, and MCP integration state.
// ABOUTME: Reports pending local-MCP startup honestly instead of certifying it.

package claude

import (
	"context"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"time"
)

// CheckStatus is passed, failed, or unverified. Unverified marks behavior the
// adapter cannot prove yet (local MCP startup before A01), never silent health.
type CheckStatus string

const (
	CheckPassed     CheckStatus = "passed"
	CheckFailed     CheckStatus = "failed"
	CheckUnverified CheckStatus = "unverified"
)

// Check is one bounded doctor diagnostic. Detail carries no secret, prompt, or
// transcript; paths stay at the file-label level for committable evidence.
type Check struct {
	Name   string
	Status CheckStatus
	Code   string
	Detail string
}

// Report is the ordered doctor outcome for one Claude home directory.
type Report struct {
	Provider string
	Version  string
	Home     bool
	Checks   []Check
}

// Failed reports whether any required check failed. Unverified checks do not
// fail the report; they name the pending owner.
func (report Report) Failed() bool {
	for _, check := range report.Checks {
		if check.Status == CheckFailed {
			return true
		}
	}
	return false
}

// Diagnose runs every listed diagnostic against home with the given launcher
// and Claude binary paths. Empty binary resolves through PATH. Every check is
// bounded and read-only; nothing here mutates configuration.
func Diagnose(home, launcher, binary string) Report {
	report := Report{Provider: "claude", Home: home != ""}
	add := func(name string, status CheckStatus, code, detail string) {
		report.Checks = append(report.Checks, Check{Name: name, Status: status, Code: code, Detail: detail})
	}
	if home == "" || launcher == "" {
		add("configuration", CheckFailed, "provider_config_invalid", "home and launcher are required")
		return report
	}
	if binary == "" {
		resolved, err := ResolveBinary()
		if err != nil {
			add("binary", CheckFailed, "provider_unavailable", "claude executable not found on PATH")
			return report
		}
		binary = resolved
	}
	if info, err := os.Stat(binary); err != nil || info.IsDir() || info.Mode().Perm()&0111 == 0 {
		add("binary", CheckFailed, "provider_unavailable", "claude executable is not runnable")
		return report
	}
	add("binary", CheckPassed, "binary_present", "claude executable resolves")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	version, err := ObserveVersion(ctx, binary, TightenEnvironment(os.Environ()))
	if err != nil {
		add("version", CheckFailed, "provider_probe_failed", "bounded --version probe failed")
		return report
	}
	report.Version = version
	if version != TestedVersion {
		add("version", CheckFailed, "unknown_version", "version is not certified for tracked launch")
		return report
	}
	add("version", CheckPassed, "version_supported", "tested version")
	owned, err := ownedSettings(home)
	if err != nil {
		add("hooks", CheckFailed, "provider_config_invalid", "user settings do not parse")
		return report
	}
	if settingsDisabled(home) {
		add("hooks_enabled", CheckFailed, "hooks_disabled", "disableAllHooks is set in user settings")
	} else {
		add("hooks_enabled", CheckPassed, "hooks_enabled", "hook dispatch stays enabled")
	}
	duplicates := false
	missing := false
	drifted := false
	for _, event := range HookEvents {
		handlers, _ := owned[event].([]any)
		if len(handlers) == 0 {
			missing = true
			continue
		}
		if len(handlers) > 1 {
			duplicates = true
		}
		for _, handler := range handlers {
			current, ok := handler.(map[string]any)
			command, _ := current["command"].(string)
			if !ok || command != launcher {
				drifted = true
			}
		}
	}
	switch {
	case duplicates:
		add("hooks", CheckFailed, "duplicate_hooks", "an event carries more than one BFB handler; re-run setup")
	case missing:
		add("hooks", CheckFailed, "hooks_missing", "a subscribed event lacks the BFB handler; run setup")
	case drifted:
		add("hooks", CheckFailed, "hooks_drift", "a BFB handler points at another launcher; re-run setup")
	default:
		add("hooks", CheckPassed, "hooks_registered", "every subscribed event carries the current handler once")
	}
	server, err := ownedMCPServer(home)
	if err != nil {
		add("mcp", CheckFailed, "provider_config_invalid", "user MCP config does not parse")
		return report
	}
	if !reflect.DeepEqual(canonicalSingle(server), canonicalSingle(desiredServer(launcher))) {
		add("mcp", CheckFailed, "mcp_drift", "bfb MCP server entry is missing or stale; run setup")
	} else {
		add("mcp", CheckPassed, "mcp_registered", "bfb MCP server entry is current")
	}
	add("mcp_startup", probeMCPStartup(launcher), "mcp_startup_unverified", "local MCP startup needs the run-scoped server (A01)")
	if info, err := os.Stat(launcher); err != nil || info.IsDir() || info.Mode().Perm()&0111 == 0 {
		add("launcher", CheckFailed, "launcher_unresolvable", "hook launcher does not resolve")
		return report
	}
	add("launcher", CheckPassed, "launcher_resolves", "stable hook launcher resolves")
	if hash, err := IntegrationHash(home, launcher); err != nil {
		add("integration", CheckFailed, "provider_config_invalid", "integration content does not parse")
	} else {
		add("integration", CheckPassed, "integration_hash", strings.TrimPrefix(hash, "sha256:")[:16])
	}
	return report
}

func settingsDisabled(home string) bool {
	data, present, err := readBounded(SettingsPath(home))
	if err != nil || !present {
		return false
	}
	object, err := parseObject(data)
	if err != nil {
		return false
	}
	disabled, _ := object["disableAllHooks"].(bool)
	return disabled
}

// probeMCPStartup attempts the bounded run-scoped MCP handshake. Until A01
// implements `bfb mcp stdio`, every outcome stays unverified: an absent,
// failing, or even succeeding launcher proves no handshake protocol yet.
func probeMCPStartup(launcher string) CheckStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, launcher, "mcp", "stdio")
	command.Env = []string{}
	command.Stdin = strings.NewReader("")
	_ = command.Run()
	return CheckUnverified
}
