// ABOUTME: Copies bounded artifact bytes through the execution's authenticated pinned directory.
// ABOUTME: Rejects path aliases and replacements without creating files or exporting local authority.

package supervisor

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"github.com/qdis/bfb/internal/protocol/generated"
	"golang.org/x/sys/unix"
)

// ReadArtifactSnapshot uses only persisted launch preparation as directory
// authority. The returned copy is independent of later changes to the file.
// Callers still check current kernel, cloud and directory authority after waits.
func (files *AssignmentFiles) ReadArtifactSnapshot(ctx context.Context, assignment generated.LocalExecutionAssignment, checkoutRoot, relative string, limit int64) ([]byte, error) {
	if ctx.Err() != nil || !artifactRelativePath(relative) || limit < 1 || limit > 5*1024*1024 {
		return nil, failure("invalid_request")
	}
	preparation, err := files.ReadPreparation(assignment, checkoutRoot)
	if err != nil {
		return nil, err
	}
	root := preparation.Artifacts
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, failure("unsafe_state")
	}
	parent := os.NewFile(uintptr(fd), root.Path)
	directories := []*os.File{parent}
	defer func() {
		for _, directory := range directories {
			_ = directory.Close()
		}
	}()
	info, err := parent.Stat()
	if err != nil || !info.IsDir() || !privateOwned(info) {
		return nil, failure("unsafe_state")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || fmt.Sprintf("%d:%d", stat.Dev, stat.Ino) != root.Identity {
		return nil, failure("execution_assignment_invalid")
	}
	parts := strings.Split(relative, "/")
	for _, part := range parts[:len(parts)-1] {
		fd, err = unix.Openat(int(parent.Fd()), part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, failure("invalid_request")
		}
		child := os.NewFile(uintptr(fd), filepath.Join(parent.Name(), part))
		directories = append(directories, child)
		info, err = child.Stat()
		if err != nil || !info.IsDir() || !privateOwned(info) {
			return nil, failure("unsafe_state")
		}
		parent = child
	}
	name := parts[len(parts)-1]
	fd, err = unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, failure("invalid_request")
	}
	file := os.NewFile(uintptr(fd), filepath.Join(parent.Name(), name))
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || !privateOwned(before) || before.Size() < 1 {
		return nil, failure("invalid_request")
	}
	if before.Size() > limit {
		return nil, failure("body_too_large")
	}
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		clear(content)
		return nil, failure("storage_failed")
	}
	if int64(len(content)) > limit {
		clear(content)
		return nil, failure("body_too_large")
	}
	after, err := file.Stat()
	current, currentErr := os.Lstat(file.Name())
	if ctx.Err() != nil || err != nil || currentErr != nil || !current.Mode().IsRegular() || !privateOwned(after) ||
		!os.SameFile(before, after) || !os.SameFile(after, current) || before.Size() != int64(len(content)) ||
		after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		clear(content)
		return nil, failure("unsafe_state")
	}
	for _, directory := range directories {
		expected, statErr := directory.Stat()
		actual, actualErr := os.Lstat(directory.Name())
		if statErr != nil || actualErr != nil || !actual.IsDir() || !privateOwned(actual) || !os.SameFile(expected, actual) {
			clear(content)
			return nil, failure("execution_assignment_invalid")
		}
	}
	if _, err := files.ReadPreparation(assignment, checkoutRoot); err != nil {
		clear(content)
		return nil, err
	}
	return content, nil
}

func artifactRelativePath(path string) bool {
	if path == "" || len(path) > 4096 || !utf8.ValidString(path) || filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsFunc(path, unicode.IsControl) {
		return false
	}
	for _, component := range strings.Split(path, "/") {
		if component == "" || component == "." || component == ".." {
			return false
		}
	}
	return true
}
