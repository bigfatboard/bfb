// ABOUTME: Checks Darwin dynamic code validity before returning a running native executable's path.
// ABOUTME: Leaves trusted BFB helper authentication separate from allowlisted provider-image observation.

//go:build darwin && cgo

package supervisor

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <limits.h>

static char *bfb_native_executable(int pid) {
  CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
  if (!number) return NULL;
  const void *keys[] = { kSecGuestAttributePid };
  const void *values[] = { number };
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  CFDictionaryRef information = NULL;
  char *path = NULL;
  OSStatus status = attributes ? SecCodeCopyGuestWithAttributes(NULL, attributes,
      kSecCSDefaultFlags, &code) : errSecAllocate;
  // CheckValidity verifies that disk signing information matches running code.
  // CopySigningInformation alone may read a different signature from disk.
  if (status == errSecSuccess) status = SecCodeCheckValidity(code, kSecCSStrictValidate, NULL);
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(code,
      kSecCSDefaultFlags, &information);
  if (status == errSecSuccess) {
    CFURLRef executable = CFDictionaryGetValue(information, kSecCodeInfoMainExecutable);
    CFDataRef unique = CFDictionaryGetValue(information, kSecCodeInfoUnique);
    if (executable && CFGetTypeID(executable) == CFURLGetTypeID() && unique &&
        CFGetTypeID(unique) == CFDataGetTypeID() && CFDataGetLength(unique) > 0) {
      path = malloc(PATH_MAX);
      if (path && !CFURLGetFileSystemRepresentation(executable, true, (UInt8 *)path, PATH_MAX)) {
        free(path); path = NULL;
      }
    }
  }
  if (information) CFRelease(information);
  if (code) CFRelease(code);
  if (attributes) CFRelease(attributes);
  CFRelease(number);
  return path;
}
*/
import "C"

import "unsafe"

func nativeExecutable(pid int) (string, error) {
	if pid <= 1 || pid > 2147483647 {
		return "", failure("containment_unknown")
	}
	path := C.bfb_native_executable(C.int(pid))
	if path == nil {
		return "", failure("provider_unavailable")
	}
	defer C.free(unsafe.Pointer(path))
	return C.GoString(path), nil
}
