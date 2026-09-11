// ABOUTME: Writes bounded rotating daemon diagnostics using an allowlist of safe structured fields.
// ABOUTME: Rejects arbitrary content and revalidates stored entries before exposing CLI log output.

package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const maxLogBytes = 256 * 1024

var ulidPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

type LogEvent struct {
	At        string `json:"at"`
	Event     string `json:"event"`
	Code      string `json:"code,omitempty"`
	RequestID string `json:"request_id,omitempty"`
}

type Logger struct {
	mu   sync.Mutex
	root string
	path string
	max  int64
}

func NewLogger(paths Paths) *Logger {
	return &Logger{root: paths.Root, path: filepath.Join(paths.Logs, "daemon.jsonl"), max: maxLogBytes}
}

func validLogEvent(event LogEvent) bool {
	switch event.Event {
	case "daemon_started", "daemon_stopped", "rpc_rejected", "rpc_failed", "recovery_required":
	default:
		return false
	}
	if event.Code != "" {
		if _, ok := failures[event.Code]; !ok {
			return false
		}
	}
	if event.RequestID != "" && !ulidPattern.MatchString(event.RequestID) {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, event.At)
	return err == nil
}

func (l *Logger) Record(event LogEvent) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.checkDirectories(); err != nil {
		return err
	}
	event.At = time.Now().UTC().Format(time.RFC3339Nano)
	if !validLogEvent(event) {
		return &Failure{Code: "invalid_request"}
	}
	data, _ := json.Marshal(event)
	if info, err := os.Lstat(l.path); err == nil {
		if !info.Mode().IsRegular() || !privateOwner(info) {
			return &Failure{Code: "log_failed"}
		}
		if info.Size()+int64(len(data)+1) > l.max {
			for n := 2; n >= 0; n-- {
				source := l.path
				if n > 0 {
					source += "." + strconv.Itoa(n)
				}
				target := l.path + "." + strconv.Itoa(n+1)
				if err := checkOptionalFile(source); err != nil {
					return &Failure{Code: "log_failed"}
				}
				if err := checkOptionalFile(target); err != nil {
					return &Failure{Code: "log_failed"}
				}
				if err := os.Rename(source, target); err != nil && !errors.Is(err, os.ErrNotExist) {
					return &Failure{Code: "log_failed"}
				}
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return &Failure{Code: "log_failed"}
	}
	f, err := privateFile(l.path, unix.O_CREAT|unix.O_WRONLY|unix.O_APPEND)
	if err != nil {
		return &Failure{Code: "log_failed"}
	}
	defer func() { _ = f.Close() }()
	if _, err = f.Write(append(data, '\n')); err != nil {
		return &Failure{Code: "log_failed"}
	}
	return nil
}

func (l *Logger) Read(limit int) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit < 1 || limit > 200 {
		return nil, &Failure{Code: "invalid_request"}
	}
	result := []string{}
	if _, err := os.Lstat(l.root); errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err := l.checkDirectories(); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(l.path); errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	f, err := privateFile(l.path, unix.O_RDONLY)
	if err != nil {
		return nil, &Failure{Code: "log_failed"}
	}
	defer func() { _ = f.Close() }()
	scanner := bufio.NewScanner(io.LimitReader(f, maxLogBytes+1))
	scanner.Buffer(make([]byte, 512), 512)
	for scanner.Scan() {
		var event LogEvent
		if json.Unmarshal(scanner.Bytes(), &event) != nil || !validLogEvent(event) {
			continue
		}
		// Re-encode only the approved fields, dropping unknown fields from disk.
		data, _ := json.Marshal(event)
		result = append(result, string(data))
		if len(result) > limit {
			result = result[1:]
		}
	}
	if scanner.Err() != nil {
		return nil, &Failure{Code: "log_failed"}
	}
	return result, nil
}

func (l *Logger) checkDirectories() error {
	for _, directory := range []string{l.root, filepath.Dir(l.path)} {
		info, err := os.Lstat(directory)
		if err != nil || !info.IsDir() || !privateOwner(info) {
			return &Failure{Code: "log_failed"}
		}
	}
	return nil
}
