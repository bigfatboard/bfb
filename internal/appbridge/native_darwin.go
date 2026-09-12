// ABOUTME: Wakes only the signed sibling BFB app and verifies app peers against the daemon's signing team.
// ABOUTME: Uses kernel process identity and console-session checks without transporting URLs or shell input.

//go:build darwin && cgo

package appbridge

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation -framework CoreGraphics
#cgo CFLAGS: -Wno-deprecated-declarations
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <unistd.h>
#include <stdlib.h>
#include <limits.h>

static bool bfb_hardened(CFDictionaryRef info) {
  CFNumberRef flagsValue = CFDictionaryGetValue(info, kSecCodeInfoFlags);
  int flags = 0;
  if (!flagsValue || CFGetTypeID(flagsValue) != CFNumberGetTypeID() || !CFNumberGetValue(flagsValue, kCFNumberIntType, &flags) || !(flags & kSecCodeSignatureRuntime)) return false;
  CFDictionaryRef entitlements = CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict);
  if (entitlements && CFGetTypeID(entitlements) == CFDictionaryGetTypeID()) {
    CFStringRef unsafe[] = { CFSTR("com.apple.security.get-task-allow"), CFSTR("com.apple.security.cs.disable-library-validation"), CFSTR("com.apple.security.cs.allow-dyld-environment-variables") };
    for (int i = 0; i < 3; i++) if (CFDictionaryGetValue(entitlements, unsafe[i]) == kCFBooleanTrue) return false;
  }
  return true;
}

static SecRequirementRef bfb_requirement(CFStringRef identifier) {
  SecCodeRef self = NULL;
  SecRequirementRef daemonRequirement = NULL, appRequirement = NULL;
  CFDictionaryRef info = NULL;
  OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &self);
  if (status == errSecSuccess) status = SecRequirementCreateWithString(CFSTR("identifier \"com.tenira.bfb.daemon\" and anchor apple generic"), kSecCSDefaultFlags, &daemonRequirement);
  if (status == errSecSuccess) status = SecCodeCheckValidity(self, kSecCSStrictValidate, daemonRequirement);
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(self, kSecCSSigningInformation, &info);
  if (status == errSecSuccess && bfb_hardened(info)) {
    CFStringRef team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
    if (team && CFGetTypeID(team) == CFStringGetTypeID() && CFStringGetLength(team) == 10) {
      CFStringRef text = CFStringCreateWithFormat(NULL, NULL, CFSTR("identifier \"%@\" and anchor apple generic and certificate leaf[subject.OU] = \"%@\""), identifier, team);
      SecRequirementCreateWithString(text, kSecCSDefaultFlags, &appRequirement);
      CFRelease(text);
    }
  }
  if (info) CFRelease(info);
  if (daemonRequirement) CFRelease(daemonRequirement);
  if (self) CFRelease(self);
  return appRequirement;
}

static SecCodeRef bfb_checked_pid(int pid, CFStringRef identifier) {
  SecRequirementRef requirement = bfb_requirement(identifier);
  if (!requirement) return NULL;
  CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
  const void *keys[] = { kSecGuestAttributePid };
  const void *values[] = { number };
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  CFDictionaryRef info = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
  if (status == errSecSuccess) status = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
  bool valid = status == errSecSuccess && bfb_hardened(info);
  if (info) CFRelease(info);
  CFRelease(attributes); CFRelease(number); CFRelease(requirement);
  if (!valid && code) { CFRelease(code); code = NULL; }
  return code;
}

static bool bfb_verify_app_pid(int pid) {
  SecCodeRef code = bfb_checked_pid(pid, CFSTR("com.qdis.bfb"));
  if (!code) return false;
  CFRelease(code);
  return true;
}

static char *bfb_helper_path(int pid) {
  SecCodeRef peer = bfb_checked_pid(pid, CFSTR("com.tenira.bfb.daemon"));
  SecCodeRef self = bfb_checked_pid(getpid(), CFSTR("com.tenira.bfb.daemon"));
  CFDictionaryRef peerInfo = NULL, selfInfo = NULL;
  char *path = NULL;
  if (peer && self &&
      SecCodeCopySigningInformation(peer, kSecCSSigningInformation, &peerInfo) == errSecSuccess &&
      SecCodeCopySigningInformation(self, kSecCSSigningInformation, &selfInfo) == errSecSuccess) {
    CFDataRef peerHash = CFDictionaryGetValue(peerInfo, kSecCodeInfoUnique);
    CFDataRef selfHash = CFDictionaryGetValue(selfInfo, kSecCodeInfoUnique);
    CFURLRef executable = CFDictionaryGetValue(peerInfo, kSecCodeInfoMainExecutable);
    if (peerHash && selfHash && executable && CFGetTypeID(peerHash) == CFDataGetTypeID() &&
        CFGetTypeID(selfHash) == CFDataGetTypeID() && CFGetTypeID(executable) == CFURLGetTypeID() &&
        CFEqual(peerHash, selfHash)) {
      path = malloc(PATH_MAX);
      if (path && !CFURLGetFileSystemRepresentation(executable, true, (UInt8 *)path, PATH_MAX)) {
        free(path); path = NULL;
      }
    }
  }
  if (peerInfo) CFRelease(peerInfo);
  if (selfInfo) CFRelease(selfInfo);
  if (peer) CFRelease(peer);
  if (self) CFRelease(self);
  return path;
}

static bool bfb_verify_app_path(const char *path) {
  SecRequirementRef requirement = bfb_requirement(CFSTR("com.qdis.bfb"));
  if (!requirement) return false;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), true);
  SecStaticCodeRef code = NULL;
  CFDictionaryRef info = NULL;
  OSStatus status = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
  if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckNestedCode, requirement);
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
  bool valid = status == errSecSuccess && bfb_hardened(info);
  if (info) CFRelease(info);
  if (code) CFRelease(code);
  CFRelease(url); CFRelease(requirement);
  return valid;
}

static int bfb_console_session(void) {
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  if (!session) return 1;
  CFNumberRef uidValue = CFDictionaryGetValue(session, kCGSessionUserIDKey);
  int uid = -1;
  bool available = uidValue && CFGetTypeID(uidValue) == CFNumberGetTypeID() && CFNumberGetValue(uidValue, kCFNumberIntType, &uid) && uid == getuid()
    && CFDictionaryGetValue(session, kCGSessionOnConsoleKey) == kCFBooleanTrue
    && CFDictionaryGetValue(session, kCGSessionLoginDoneKey) == kCFBooleanTrue;
  bool locked = CFDictionaryGetValue(session, CFSTR("CGSSessionScreenIsLocked")) == kCFBooleanTrue;
  CFRelease(session);
  return !available ? 1 : locked ? 2 : 0;
}
*/
import "C"

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unsafe"

	"github.com/qdis/bfb/internal/daemon"
)

func authorizeApp(peer daemon.Peer) error {
	if peer.UID != os.Getuid() || peer.PID <= 0 || !bool(C.bfb_verify_app_pid(C.int(peer.PID))) {
		return &daemon.Failure{Code: "peer_denied"}
	}
	return nil
}

// HelperExecutable accepts the daemon's exact hardened signed helper build,
// not another same-user process or another version with the same identifier.
func HelperExecutable(peer daemon.Peer) (string, error) {
	if peer.UID != os.Getuid() || peer.PID <= 1 {
		return "", &daemon.Failure{Code: "peer_denied"}
	}
	path := C.bfb_helper_path(C.int(peer.PID))
	if path == nil {
		return "", &daemon.Failure{Code: "peer_denied"}
	}
	defer C.free(unsafe.Pointer(path))
	return C.GoString(path), nil
}

func wakeInstalledApp(ctx context.Context) error {
	switch int(C.bfb_console_session()) {
	case 1:
		return &daemon.Failure{Code: "app_unavailable"}
	case 2:
		return &daemon.Failure{Code: "session_locked"}
	}
	executable, err := os.Executable()
	if err != nil {
		return &daemon.Failure{Code: "app_unavailable"}
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return &daemon.Failure{Code: "app_unavailable"}
	}
	suffix := string(filepath.Separator) + filepath.Join("Contents", "Helpers", "bfb")
	if !strings.HasSuffix(executable, suffix) {
		return &daemon.Failure{Code: "app_unavailable"}
	}
	bundle := strings.TrimSuffix(executable, suffix)
	path := C.CString(bundle)
	defer C.free(unsafe.Pointer(path))
	if !bool(C.bfb_verify_app_path(path)) {
		return &daemon.Failure{Code: "app_unavailable"}
	}
	// LaunchServices receives the fixed sibling application, never a wake link, intent or task field.
	if err := exec.CommandContext(ctx, "/usr/bin/open", "-g", "-a", bundle).Run(); err != nil {
		return &daemon.Failure{Code: "app_unavailable"}
	}
	return nil
}
