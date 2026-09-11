// ABOUTME: Attempts a direct Keychain read without using BFB's signed-code validation.
// ABOUTME: Reports only the OS result so unauthorized test probes cannot disclose credential bytes.

import Foundation
import Security

guard CommandLine.arguments.count == 2 else { exit(2) }
SecKeychainSetUserInteractionAllowed(false)
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "com.tenira.bfb.runner",
  kSecAttrAccount as String: CommandLine.arguments[1],
  kSecAttrSynchronizable as String: false,
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne,
]
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
print("{\"read_allowed\":\(status == errSecSuccess),\"os_status\":\(status)}")
exit(status == errSecSuccess ? 1 : 0)
