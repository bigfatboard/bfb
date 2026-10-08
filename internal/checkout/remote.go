// ABOUTME: Normalizes supported hosted Git remotes without retaining credentials or local paths.
// ABOUTME: Validates explicit repository and monorepo bindings before a checkout can be linked.

package checkout

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/qdis/bfb/internal/daemon"
)

var (
	idPattern                = regexp.MustCompile("^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
	hostPattern              = regexp.MustCompile("^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$")
	repositorySegmentPattern = regexp.MustCompile("^[A-Za-z0-9._-]{1,128}$")
	remoteNamePattern        = regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
	headPattern              = regexp.MustCompile("^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
)

func failure(code string) error { return &daemon.Failure{Code: code} }

func hasControl(value string) bool {
	if !utf8.ValidString(value) {
		return true
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}

// NormalizeRepositoryIdentity accepts a hosted identity, never a remote URL or local path.
func NormalizeRepositoryIdentity(value string) (string, error) {
	if value != strings.TrimSpace(value) || hasControl(value) || strings.ContainsAny(value, `\:@%?#`) {
		return "", failure("checkout_repository_mismatch")
	}
	parts := strings.Split(value, "/")
	if len(parts) < 3 || len(value) > 512 {
		return "", failure("checkout_repository_mismatch")
	}
	host := strings.ToLower(parts[0])
	if !hostPattern.MatchString(host) || strings.Contains(host, "..") {
		return "", failure("checkout_repository_mismatch")
	}
	for _, segment := range parts[1:] {
		if segment == "." || segment == ".." || !repositorySegmentPattern.MatchString(segment) {
			return "", failure("checkout_repository_mismatch")
		}
	}
	parts[0] = host
	if host == "github.com" {
		if len(parts) != 3 {
			return "", failure("checkout_repository_mismatch")
		}
		parts[1], parts[2] = strings.ToLower(parts[1]), strings.ToLower(parts[2])
	}
	return strings.Join(parts, "/"), nil
}

// NormalizeRemote supports HTTPS, SSH URLs and scp-style SSH at their standard ports.
func NormalizeRemote(value string) (string, error) {
	if value == "" || len(value) > 4096 || hasControl(value) || value != strings.TrimSpace(value) {
		return "", failure("checkout_repository_mismatch")
	}
	var host, repository string
	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "ssh") || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" {
			return "", failure("checkout_repository_mismatch")
		}
		port := parsed.Port()
		if port != "" && !((parsed.Scheme == "https" && port == "443") || (parsed.Scheme == "ssh" && port == "22")) {
			return "", failure("checkout_repository_mismatch")
		}
		host, repository = parsed.Hostname(), strings.TrimPrefix(parsed.Path, "/")
	} else {
		left, right, found := strings.Cut(value, ":")
		if !found || strings.Contains(left, "/") || strings.HasPrefix(right, "/") {
			return "", failure("checkout_repository_mismatch")
		}
		if _, after, found := strings.Cut(left, "@"); found {
			left = after
		}
		host, repository = left, right
	}
	repository = strings.TrimSuffix(strings.TrimSuffix(repository, "/"), ".git")
	return NormalizeRepositoryIdentity(host + "/" + repository)
}

func normalizeSubpath(value string) (string, error) {
	if value == "." {
		return value, nil
	}
	if value == "" || len(value) > 512 || value != strings.TrimSpace(value) || strings.HasPrefix(value, "~") || hasControl(value) || strings.ContainsAny(value, `\:`) {
		return "", failure("checkout_subpath_mismatch")
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." || utf8.RuneCountInString(segment) > 128 {
			return "", failure("checkout_subpath_mismatch")
		}
	}
	return value, nil
}

func validLabel(value string) bool {
	return value != "" && value == strings.TrimSpace(value) && utf8.RuneCountInString(value) <= 128 && !hasControl(value) && !strings.ContainsAny(value, `/\`)
}

func validBranch(value string) bool {
	if value == "" || len(value) > 255 || hasControl(value) || strings.ContainsAny(value, " ~^:?*[\\") || strings.Contains(value, "..") || strings.Contains(value, "@{") || strings.Contains(value, "//") || strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if strings.HasPrefix(segment, ".") || strings.HasSuffix(segment, ".lock") {
			return false
		}
	}
	return true
}
