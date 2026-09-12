// ABOUTME: Fingerprints executable/configuration identity and probes only compiled provider descriptors.
// ABOUTME: Revalidates short-lived capability evidence immediately before a local invocation may execute.

package provider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type FileStamp struct {
	RequestedPath, CanonicalPath, Identity, Hash string
	Size                                         int64
	Mode                                         os.FileMode
	Modified                                     time.Time
}

func Hash(data []byte) string { return fmt.Sprintf("sha256:%x", sha256.Sum256(data)) }

// FingerprintExecutable shares the provider kit's no-follow identity checks
// with the signed supervisor handoff; it grants no invocation authority.
func FingerprintExecutable(path string) (FileStamp, error) { return fingerprint(path, true) }

func fingerprint(path string, executable bool) (FileStamp, error) {
	if !filepath.IsAbs(path) || len(path) > 4096 || strings.ContainsAny(path, "\x00\r\n") {
		return FileStamp{}, Failure("provider_path_unsafe")
	}
	canonical := filepath.Clean(path)
	var err error
	if executable {
		canonical, err = filepath.EvalSymlinks(canonical)
		if err != nil {
			return FileStamp{}, Failure("provider_unavailable")
		}
	}
	fd, err := unix.Open(canonical, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return FileStamp{}, Failure("provider_path_unsafe")
	}
	file := os.NewFile(uintptr(fd), canonical)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
		return FileStamp{}, Failure("provider_path_unsafe")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (stat.Uid != uint32(os.Getuid()) && stat.Uid != 0) {
		return FileStamp{}, Failure("provider_path_unsafe")
	}
	limit := int64(2 * 1024 * 1024)
	if executable {
		limit = 512 * 1024 * 1024
		if info.Mode().Perm()&0111 == 0 {
			return FileStamp{}, Failure("provider_path_unsafe")
		}
	}
	if info.Size() > limit {
		return FileStamp{}, Failure("provider_path_unsafe")
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, limit+1))
	if err != nil || n > limit {
		return FileStamp{}, Failure("provider_path_unsafe")
	}
	after, err := file.Stat()
	current, currentErr := os.Stat(canonical)
	if err != nil || currentErr != nil || !os.SameFile(info, current) || after.Size() != info.Size() || after.ModTime() != info.ModTime() {
		return FileStamp{}, Failure("provider_changed")
	}
	if executable {
		again, err := filepath.EvalSymlinks(path)
		if err != nil || again != canonical {
			return FileStamp{}, Failure("provider_changed")
		}
	}
	return FileStamp{RequestedPath: path, CanonicalPath: canonical, Identity: fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), Hash: fmt.Sprintf("sha256:%x", hash.Sum(nil)), Size: n, Mode: info.Mode(), Modified: info.ModTime()}, nil
}

func configurationHash(sources []ConfigSource) (string, error) {
	if len(sources) > 16 {
		return "", Failure("provider_config_invalid")
	}
	sources = slices.Clone(sources)
	slices.SortFunc(sources, func(a, b ConfigSource) int { return strings.Compare(a.Name, b.Name) })
	type configStamp struct {
		Name    string
		Stamp   FileStamp
		Missing bool
	}
	stamps := make([]configStamp, 0, len(sources))
	for index, source := range sources {
		if !namePattern.MatchString(source.Name) || !filepath.IsAbs(source.Path) || (index > 0 && sources[index-1].Name == source.Name) {
			return "", Failure("provider_config_invalid")
		}
		_, err := os.Lstat(source.Path)
		if errors.Is(err, os.ErrNotExist) {
			stamps = append(stamps, configStamp{Name: source.Name, Stamp: FileStamp{RequestedPath: source.Path}, Missing: true})
			continue
		}
		if err != nil {
			return "", Failure("provider_path_unsafe")
		}
		stamp, err := fingerprint(source.Path, false)
		if err != nil {
			return "", err
		}
		stamps = append(stamps, configStamp{Name: source.Name, Stamp: stamp})
	}
	data, _ := json.Marshal(stamps)
	return Hash(data), nil
}

type limitedWriter struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (writer *limitedWriter) Write(data []byte) (int, error) {
	if len(data) > writer.limit-writer.Len() {
		writer.exceeded = true
		return 0, errors.New("bounded provider output")
	}
	return writer.Buffer.Write(data)
}

// InspectCommand accepts only locally compiled arguments; raw output never becomes a diagnostic.
func InspectCommand(ctx context.Context, installation Installation, arguments ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, installation.Executable, arguments...)
	command.Dir = filepath.Dir(installation.Executable)
	command.Env = append([]string{}, installation.Environment...)
	command.WaitDelay = time.Second
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		if err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			return err
		}
		return nil
	}
	stdout, stderr := &limitedWriter{limit: 64 * 1024}, &limitedWriter{limit: 4096}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Run(); err != nil || stdout.exceeded || stderr.exceeded {
		return nil, Failure("provider_probe_failed")
	}
	return stdout.Bytes(), nil
}

type Registry struct{ descriptors map[string]Descriptor }

func NewRegistry(descriptors []Descriptor) (*Registry, error) {
	registry := &Registry{descriptors: map[string]Descriptor{}}
	for _, descriptor := range descriptors {
		if !namePattern.MatchString(descriptor.Name) || registry.descriptors[descriptor.Name].Name != "" || descriptor.ParseVersion == nil || len(descriptor.VersionArguments) == 0 || descriptor.Manifest.Provider != descriptor.Name || !versionPattern.MatchString(descriptor.Manifest.Version) {
			return nil, Failure("provider_manifest_invalid")
		}
		for _, version := range descriptor.Manifest.TestedVersions {
			if !versionPattern.MatchString(version) {
				return nil, Failure("provider_manifest_invalid")
			}
		}
		for _, capability := range descriptor.Manifest.Capabilities {
			if !namePattern.MatchString(capability) {
				return nil, Failure("provider_manifest_invalid")
			}
		}
		for _, model := range descriptor.Manifest.Models {
			if !modelPattern.MatchString(model) {
				return nil, Failure("provider_manifest_invalid")
			}
		}
		descriptor.Manifest.Capabilities = Intersection(descriptor.Manifest.Capabilities)
		descriptor.Manifest.TestedVersions = slices.Clone(descriptor.Manifest.TestedVersions)
		descriptor.Manifest.Models = slices.Clone(descriptor.Manifest.Models)
		descriptor.VersionArguments = slices.Clone(descriptor.VersionArguments)
		registry.descriptors[descriptor.Name] = descriptor
	}
	return registry, nil
}

func (registry *Registry) Names() []string {
	names := make([]string, 0, len(registry.descriptors))
	for name := range registry.descriptors {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func manifestID(manifest Manifest) string { data, _ := json.Marshal(manifest); return Hash(data) }

func (registry *Registry) Probe(ctx context.Context, name string, installation Installation, now time.Time) (Probe, error) {
	return registry.probe(ctx, name, installation, "", now)
}

// ProbeBound rejects replaced executable/configuration sources before invoking
// even a version or health command. expectedSource comes from a sealed probe.
func (registry *Registry) ProbeBound(ctx context.Context, name string, installation Installation, expectedSource string, now time.Time) (Probe, error) {
	if !hashPattern.MatchString(expectedSource) {
		return Probe{}, Failure("provider_probe_invalid")
	}
	return registry.probe(ctx, name, installation, expectedSource, now)
}

func sourceHash(executable FileStamp, configuration, integration string) string {
	data, _ := json.Marshal(struct {
		Domain        string
		Executable    FileStamp
		Configuration string
		Integration   string
	}{"bfb-provider-source/1", executable, configuration, integration})
	return Hash(data)
}

// InstallationSource preserves the exact original probe inputs across helpers.
// Returned slices are copies; callers must not persist the ambient environment.
func (registry *Registry) InstallationSource(probe Probe) (Installation, string, error) {
	if probe.registry != registry || probe.seal != probeSeal(probe) {
		return Installation{}, "", Failure("provider_probe_invalid")
	}
	installation := probe.installation
	installation.ConfigFiles = slices.Clone(installation.ConfigFiles)
	installation.Environment = slices.Clone(installation.Environment)
	return installation, sourceHash(probe.executable, probe.configurationHash, installation.IntegrationHash), nil
}

func (registry *Registry) probe(ctx context.Context, name string, installation Installation, expectedSource string, now time.Time) (Probe, error) {
	descriptor, ok := registry.descriptors[name]
	if !ok {
		return Probe{}, Failure("provider_unavailable")
	}
	installation.ConfigFiles = slices.Clone(installation.ConfigFiles)
	installation.Environment = slices.Clone(installation.Environment)
	executable, err := fingerprint(installation.Executable, true)
	if err != nil {
		return Probe{}, err
	}
	configHash, err := configurationHash(installation.ConfigFiles)
	if err != nil {
		return Probe{}, err
	}
	if !hashPattern.MatchString(installation.IntegrationHash) || !validEnvironment(installation.Environment) {
		return Probe{}, Failure("provider_config_invalid")
	}
	if expectedSource != "" && sourceHash(executable, configHash, installation.IntegrationHash) != expectedSource {
		return Probe{}, Failure("provider_changed")
	}
	local := installation
	local.Executable = executable.CanonicalPath
	data, err := InspectCommand(ctx, local, descriptor.VersionArguments...)
	if err != nil {
		return Probe{}, err
	}
	version, err := descriptor.ParseVersion(data)
	if err != nil || !versionPattern.MatchString(version) {
		return Probe{}, Failure("provider_probe_failed")
	}
	probe := Probe{Provider: name, Version: version, ManifestID: manifestID(descriptor.Manifest), Capabilities: []string{}, Status: "unknown_version", ObservedAt: now, ExpiresAt: now.Add(30 * time.Second), installation: installation, executable: executable, configurationHash: configHash}
	if slices.Contains(descriptor.Manifest.TestedVersions, version) && descriptor.Adapter != nil {
		health, err := descriptor.Adapter.Inspect(ctx, local)
		if err != nil {
			return Probe{}, err
		}
		if health.Healthy && health.IntegrationHash == installation.IntegrationHash {
			probe.Capabilities = Intersection(descriptor.Manifest.Capabilities, health.Capabilities)
			probe.Status = "healthy"
		} else {
			probe.Status = "integration_unhealthy"
		}
	}
	after, err := fingerprint(installation.Executable, true)
	if err != nil || after != executable {
		return Probe{}, Failure("provider_changed")
	}
	afterConfig, err := configurationHash(installation.ConfigFiles)
	if err != nil || configHash != afterConfig {
		return Probe{}, Failure("provider_changed")
	}
	probe.registry = registry
	probe.seal = probeSeal(probe)
	return probe, nil
}

func probeSeal(probe Probe) string { data, _ := json.Marshal(probe); return Hash(data) }

// IdentityHash binds a separately re-probed helper to the original local
// installation. Time and ambient environment are not durable credentials; a
// new probe must still pass its own freshness, health and capability checks.
func (registry *Registry) IdentityHash(probe Probe) (string, error) {
	if probe.registry != registry || probe.seal != probeSeal(probe) {
		return "", Failure("provider_probe_invalid")
	}
	data, err := json.Marshal(struct {
		Domain                                string
		Provider, Version, ManifestID, Status string
		Capabilities                          []string
		Executable                            FileStamp
		ConfigurationHash, IntegrationHash    string
	}{"bfb-provider-installation/1", probe.Provider, probe.Version, probe.ManifestID, probe.Status, probe.Capabilities, probe.executable, probe.configurationHash, probe.installation.IntegrationHash})
	if err != nil {
		return "", Failure("provider_probe_invalid")
	}
	return Hash(data), nil
}

func (registry *Registry) Revalidate(ctx context.Context, plan Plan, now time.Time) error {
	if plan.probe.registry != registry || plan.probe.seal != probeSeal(plan.probe) {
		return Failure("provider_probe_invalid")
	}
	if now.Before(plan.probe.ObservedAt) || !now.Before(plan.probe.ExpiresAt) {
		return Failure("provider_probe_expired")
	}
	expectedSource := sourceHash(plan.probe.executable, plan.probe.configurationHash, plan.probe.installation.IntegrationHash)
	current, err := registry.ProbeBound(ctx, plan.probe.Provider, plan.probe.installation, expectedSource, now)
	if err != nil {
		return err
	}
	before := plan.probe
	if current.ManifestID != before.ManifestID || current.Version != before.Version || current.Status != before.Status || current.executable != before.executable || current.configurationHash != before.configurationHash || !reflect.DeepEqual(current.Capabilities, before.Capabilities) {
		return Failure("provider_changed")
	}
	return nil
}
