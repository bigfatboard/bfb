// ABOUTME: Stores bounded authenticated supervision records in an anchored user-private directory.
// ABOUTME: Uses no-follow descriptors, atomic replacement and durable writes without exposing local data.

package supervisor

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"

	"golang.org/x/sys/unix"
)

const maxPrivateRecord = 128 * 1024

var privateName = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,160}$`)

type privateDirectory struct {
	file *os.File
	key  []byte
}

// The caller supplies a directory below the daemon's prepared private root, not
// a checkout. Holding the directory descriptor prevents path replacement from
// redirecting a later record write through a symlink.
func openPrivateDirectory(path string) (*privateDirectory, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return nil, failure("unsafe_state")
	}
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, failure("unsafe_state")
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, failure("unsafe_state")
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.IsDir() || !privateOwned(info) {
		_ = file.Close()
		return nil, failure("unsafe_state")
	}
	directory := &privateDirectory{file: file}
	// Serialize first creation so another helper cannot observe a partial key.
	initialization, err := directory.open("authentication.lock", unix.O_CREAT|unix.O_RDWR)
	if err == nil {
		err = unix.Flock(int(initialization.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			directory.key, err = directory.loadKey()
		}
		_ = initialization.Close()
	}
	if err != nil {
		_ = file.Close()
		return nil, failure("unsafe_state")
	}
	return directory, nil
}

func privateOwned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid()) && info.Mode().Perm()&0077 == 0 && (info.IsDir() || stat.Nlink == 1)
}

func (directory *privateDirectory) open(name string, flags int) (*os.File, error) {
	if !privateName.MatchString(name) || name == "." || name == ".." {
		return nil, failure("unsafe_state")
	}
	expected, expectedErr := directory.file.Stat()
	actual, actualErr := os.Lstat(directory.file.Name())
	if expectedErr != nil || actualErr != nil || !actual.IsDir() || !privateOwned(actual) || !os.SameFile(expected, actual) {
		return nil, failure("unsafe_state")
	}
	mode := flags | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	// Give simultaneous creators one explicit creation winner, then open the
	// existing inode without creation authority. Disappearance still fails closed.
	createOrOpen := flags&unix.O_CREAT != 0 && flags&unix.O_EXCL == 0
	if createOrOpen {
		mode |= unix.O_EXCL
	}
	fd, err := unix.Openat(int(directory.file.Fd()), name, mode, 0600)
	if createOrOpen && errors.Is(err, unix.EEXIST) {
		fd, err = unix.Openat(int(directory.file.Fd()), name, mode & ^(unix.O_CREAT|unix.O_EXCL), 0)
	}
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.EEXIST) {
			return nil, err
		}
		return nil, failure("unsafe_state")
	}
	file := os.NewFile(uintptr(fd), name)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !privateOwned(info) {
		_ = file.Close()
		return nil, failure("unsafe_state")
	}
	return file, nil
}

func (directory *privateDirectory) loadKey() ([]byte, error) {
	file, err := directory.open("authentication.key", unix.O_RDONLY)
	if errors.Is(err, unix.ENOENT) {
		key := make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		file, err = directory.open("authentication.key", unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		if _, err = file.Write(key); err == nil {
			err = file.Sync()
		}
		if err == nil {
			err = directory.file.Sync()
		}
		return key, err
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	key, err := io.ReadAll(io.LimitReader(file, 33))
	if err != nil || len(key) != 32 {
		return nil, failure("unsafe_state")
	}
	return key, nil
}

type privateEnvelope struct {
	Record        json.RawMessage `json:"record"`
	Authenticator string          `json:"authenticator"`
}

func strictPrivateJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return failure("containment_unknown")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return failure("containment_unknown")
	}
	return nil
}

func (directory *privateDirectory) authenticate(name string, data []byte) string {
	authenticator := hmac.New(sha256.New, directory.key)
	_, _ = authenticator.Write([]byte("bfb-local-supervision/1\n" + name + "\n"))
	_, _ = authenticator.Write(data)
	return hex.EncodeToString(authenticator.Sum(nil))
}

func (directory *privateDirectory) read(name string, target any) error {
	file, err := directory.open(name, unix.O_RDONLY)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxPrivateRecord+1))
	if err != nil || len(data) == 0 || len(data) > maxPrivateRecord {
		return failure("containment_unknown")
	}
	var envelope privateEnvelope
	if strictPrivateJSON(data, &envelope) != nil || !hmac.Equal([]byte(envelope.Authenticator), []byte(directory.authenticate(name, envelope.Record))) {
		return failure("containment_unknown")
	}
	canonicalEnvelope, err := json.Marshal(envelope)
	if err != nil || !bytes.Equal(canonicalEnvelope, data) {
		return failure("containment_unknown")
	}
	if err = strictPrivateJSON(envelope.Record, target); err != nil {
		return err
	}
	canonical, err := json.Marshal(target)
	if err != nil || !bytes.Equal(canonical, envelope.Record) {
		return failure("containment_unknown")
	}
	return nil
}

func (directory *privateDirectory) write(name string, value any) error {
	if !privateName.MatchString(name) || name == "." || name == ".." {
		return failure("unsafe_state")
	}
	data, err := json.Marshal(value)
	if err != nil {
		return failure("storage_failed")
	}
	envelope, err := json.Marshal(privateEnvelope{Record: data, Authenticator: directory.authenticate(name, data)})
	if err != nil || len(envelope) > maxPrivateRecord {
		return failure("storage_failed")
	}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		return failure("storage_failed")
	}
	temporary := hex.EncodeToString(nonce) + ".tmp"
	file, err := directory.open(temporary, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY)
	if err != nil {
		return failure("storage_failed")
	}
	defer func() {
		_ = file.Close()
		_ = unix.Unlinkat(int(directory.file.Fd()), temporary, 0)
	}()
	if _, err = file.Write(envelope); err == nil {
		err = file.Sync()
	}
	if err == nil {
		err = unix.Renameat(int(directory.file.Fd()), temporary, int(directory.file.Fd()), name)
	}
	if err == nil {
		err = directory.file.Sync()
	}
	if err != nil {
		return failure("storage_failed")
	}
	return nil
}
