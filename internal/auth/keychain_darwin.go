// ABOUTME: Calls macOS Keychain inside the signed daemon with an exact creator-code access list.
// ABOUTME: Disables interactive grants and never invokes a helper that could export credentials to callers.

//go:build darwin && cgo

package auth

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#cgo CFLAGS: -Wno-deprecated-declarations
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>

static OSStatus bfb_identity(void) {
  SecCodeRef code = NULL;
  SecRequirementRef requirement = NULL;
  OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &code);
  if (status == errSecSuccess) {
    status = SecRequirementCreateWithString(CFSTR("identifier \"com.tenira.bfb.daemon\" and anchor apple generic"), kSecCSDefaultFlags, &requirement);
  }
  if (status == errSecSuccess) status = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
  CFDictionaryRef information = NULL;
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
  if (status == errSecSuccess) {
    CFNumberRef value = CFDictionaryGetValue(information, kSecCodeInfoFlags);
    int flags = 0;
    if (!value || CFGetTypeID(value) != CFNumberGetTypeID() || !CFNumberGetValue(value, kCFNumberIntType, &flags) || !(flags & kSecCodeSignatureRuntime)) status = errSecAuthFailed;
    // Hardened runtime exceptions would reopen same-user debugger/library injection.
    CFDictionaryRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
    if (entitlements && CFGetTypeID(entitlements) == CFDictionaryGetTypeID()) {
      CFStringRef unsafe[] = {CFSTR("com.apple.security.get-task-allow"), CFSTR("com.apple.security.cs.disable-library-validation"), CFSTR("com.apple.security.cs.allow-dyld-environment-variables")};
      for (int index = 0; index < 3; index++) if (CFDictionaryGetValue(entitlements, unsafe[index]) == kCFBooleanTrue) status = errSecAuthFailed;
    }
  }
  if (information) CFRelease(information);
  if (requirement) CFRelease(requirement);
  if (code) CFRelease(code);
  if (status == errSecSuccess) status = SecKeychainSetUserInteractionAllowed(false);
  return status;
}

static CFMutableDictionaryRef bfb_query(const char *account) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFStringRef name = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, CFSTR("com.tenira.bfb.runner"));
  CFDictionarySetValue(query, kSecAttrAccount, name);
  CFDictionarySetValue(query, kSecAttrSynchronizable, kCFBooleanFalse);
  CFRelease(name);
  return query;
}

static OSStatus bfb_read(const char *account, void **bytes, long *length) {
  OSStatus status = bfb_identity();
  if (status != errSecSuccess) return status;
  CFMutableDictionaryRef query = bfb_query(account);
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef result = NULL;
  status = SecItemCopyMatching(query, &result);
  if (status == errSecSuccess && result && CFGetTypeID(result) == CFDataGetTypeID()) {
    *length = CFDataGetLength(result);
    if (*length <= 0 || *length > 8192) status = errSecParam;
    else {
      *bytes = malloc(*length);
      if (!*bytes) status = errSecAllocate;
      else memcpy(*bytes, CFDataGetBytePtr(result), *length);
    }
  } else if (status == errSecSuccess) status = errSecParam;
  if (result) CFRelease(result);
  CFRelease(query);
  return status;
}

static void bfb_release(void *bytes, long length) {
  if (bytes) { memset_s(bytes, length, 0, length); free(bytes); }
}

static OSStatus bfb_write(const char *account, const void *bytes, long length, bool replace) {
  OSStatus status = bfb_identity();
  if (status != errSecSuccess) return status;
  CFMutableDictionaryRef query = bfb_query(account);
  CFDataRef data = CFDataCreate(NULL, bytes, length);
  SecAccessRef access = NULL;
  // A NULL trusted list means exactly the creating code, not all applications.
  status = SecAccessCreate(CFSTR("BFB workspace runner credential"), NULL, &access);
  if (status == errSecSuccess) {
    CFDictionarySetValue(query, kSecAttrAccess, access);
    CFDictionarySetValue(query, kSecValueData, data);
    status = SecItemAdd(query, NULL);
  }
  if (status == errSecDuplicateItem && replace) {
    // Force a restricted read before replacing data. Never adopt a foreign item.
    void *previous = NULL;
    long previousLength = 0;
    status = bfb_read(account, &previous, &previousLength);
    bfb_release(previous, previousLength);
    if (status == errSecSuccess) {
      CFDictionaryRemoveValue(query, kSecAttrAccess);
      CFDictionaryRemoveValue(query, kSecValueData);
      const void *keys[] = {kSecValueData};
      const void *values[] = {data};
      CFDictionaryRef update = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
      status = SecItemUpdate(query, update);
      CFRelease(update);
    }
  }
  if (access) CFRelease(access);
  CFRelease(data);
  CFRelease(query);
  return status;
}

static OSStatus bfb_delete(const char *account) {
  void *previous = NULL;
  long length = 0;
  OSStatus status = bfb_read(account, &previous, &length);
  bfb_release(previous, length);
  if (status == errSecItemNotFound) return errSecSuccess;
  if (status != errSecSuccess) return status;
  CFMutableDictionaryRef query = bfb_query(account);
  status = SecItemDelete(query);
  CFRelease(query);
  return status;
}
*/
import "C"

import "unsafe"

func credentialStatus(status C.OSStatus) error {
	switch status {
	case C.errSecSuccess:
		return nil
	case C.errSecItemNotFound:
		return ErrCredentialNotFound
	case C.errSecDuplicateItem:
		return ErrCredentialExists
	default:
		return ErrCredentialUnavailable
	}
}

func nativeCredentialIdentity() error { return credentialStatus(C.bfb_identity()) }

func nativeCredentialRead(account string) ([]byte, error) {
	name := C.CString(account)
	defer C.free(unsafe.Pointer(name))
	var bytes unsafe.Pointer
	var length C.long
	status := C.bfb_read(name, &bytes, &length)
	defer C.bfb_release(bytes, length)
	if err := credentialStatus(status); err != nil {
		return nil, err
	}
	return C.GoBytes(bytes, C.int(length)), nil
}

func nativeCredentialWrite(account string, value []byte, replace bool) error {
	name := C.CString(account)
	defer C.free(unsafe.Pointer(name))
	return credentialStatus(C.bfb_write(name, unsafe.Pointer(&value[0]), C.long(len(value)), C.bool(replace)))
}

func nativeCredentialDelete(account string) error {
	name := C.CString(account)
	defer C.free(unsafe.Pointer(name))
	return credentialStatus(C.bfb_delete(name))
}
