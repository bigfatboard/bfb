// ABOUTME: Installs a fixed per-user launchd service with explicit executable arguments.
// ABOUTME: Refuses conflicting installations and avoids shell interpolation or elevated privileges.

package daemon

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"syscall"

	"golang.org/x/sys/unix"
)

const ServiceLabel = "com.tenira.bfb.daemon"

var labelPattern = regexp.MustCompile(`^com\.tenira\.bfb\.[a-z0-9.]{1,80}$`)

func LaunchdPlist(executable string, paths Paths, label string) ([]byte, error) {
	if !filepath.IsAbs(executable) || !filepath.IsAbs(paths.Root) || !labelPattern.MatchString(label) {
		return nil, &Failure{Code: "invalid_request"}
	}
	escape := func(value string) string {
		var out bytes.Buffer
		_ = xml.EscapeText(&out, []byte(value))
		return out.String()
	}
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>` + escape(label) + `</string>
<key>ProgramArguments</key><array><string>` + escape(executable) + `</string><string>--data-dir</string><string>` + escape(paths.Root) + `</string><string>daemon</string><string>run</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
</dict></plist>
`), nil
}

func Install(ctx context.Context, paths Paths, executable, agentsDirectory, label string) error {
	if runtime.GOOS != "darwin" {
		return &Failure{Code: "platform_unavailable"}
	}
	if err := paths.Prepare(); err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return &Failure{Code: "install_failed"}
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return &Failure{Code: "install_failed"}
	}
	data, err := LaunchdPlist(resolved, paths, label)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(agentsDirectory, 0700); err != nil {
		return &Failure{Code: "install_failed"}
	}
	info, err = os.Lstat(agentsDirectory)
	if err != nil || !info.IsDir() {
		return &Failure{Code: "unsafe_state"}
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm()&0022 != 0 {
		return &Failure{Code: "unsafe_state"}
	}
	path := filepath.Join(agentsDirectory, label+".plist")
	if err = checkOptionalFile(path); err != nil {
		return err
	}
	if previous, readErr := os.ReadFile(path); readErr == nil {
		if !bytes.Equal(previous, data) {
			return &Failure{Code: "install_conflict"}
		}
	} else if errors.Is(readErr, os.ErrNotExist) {
		// Publish a fully written file without replacing any concurrently installed file.
		file, createErr := os.CreateTemp(agentsDirectory, ".bfb-install-*.plist")
		if createErr != nil {
			return &Failure{Code: "install_failed"}
		}
		temporary := file.Name()
		defer func() { _ = os.Remove(temporary) }()
		_, writeErr := file.Write(data)
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			return &Failure{Code: "install_failed"}
		}
		if err = os.Link(temporary, path); err != nil {
			return &Failure{Code: "install_conflict"}
		}
	} else {
		return &Failure{Code: "install_failed"}
	}
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	// A second install of the exact service is idempotent, without stopping it.
	if exec.CommandContext(ctx, "/bin/launchctl", "print", domain+"/"+label).Run() == nil {
		return nil
	}
	if exec.CommandContext(ctx, "/bin/launchctl", "bootstrap", domain, path).Run() != nil {
		return &Failure{Code: "install_failed"}
	}
	return nil
}

func DefaultAgentsDirectory() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", &Failure{Code: "install_failed"}
	}
	return filepath.Join(home, "Library", "LaunchAgents"), nil
}

// ValidateFileMode is shared by install acceptance and state permission tests.
func ValidateFileMode(path string) error {
	f, err := privateFile(path, unix.O_RDONLY)
	if err == nil {
		err = f.Close()
	}
	return err
}
