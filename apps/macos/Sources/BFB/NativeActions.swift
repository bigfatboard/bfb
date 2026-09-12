// ABOUTME: Handles opaque wake links and fixed native Terminal/notification actions.
// ABOUTME: Keeps executable paths app-owned and never interprets cloud or task content as commands.

import AppKit
import CoreServices
import Foundation
import Security
import UserNotifications

struct WakeIntentID: Equatable, Sendable {
  let value: String

  init(_ value: String) throws {
    guard
      try WireSchemaValidator().accepts(
        .string(value), schema: .object(["$ref": .string("primitives.json#/$defs/Ulid")]))
    else {
      throw WireFailure.invalidEnvelope
    }
    self.value = value
  }
}

struct TerminalIntentID: Equatable, Sendable {
  let value: String

  init(_ value: String) throws {
    guard
      try WireSchemaValidator().accepts(
        .string(value),
        schema: .object(["$ref": .string("primitives.json#/$defs/TerminalIntentId")]))
    else {
      throw WireFailure.invalidEnvelope
    }
    self.value = value
  }
}

struct WakeLink: Equatable, Sendable {
  let intent: WakeIntentID

  init(_ text: String, associatedHosts: Set<String>) throws {
    guard text.utf8.count <= 512 else { throw WireFailure.invalidEnvelope }
    let prefixes = ["bfb://launch/"] + associatedHosts.sorted().map { "https://" + $0 + "/l/" }
    guard let prefix = prefixes.first(where: { text.hasPrefix($0) }) else {
      throw WireFailure.invalidEnvelope
    }
    intent = try WakeIntentID(String(text.dropFirst(prefix.count)))
  }

  func forward(to transport: any LocalRPCTransport) async throws {
    _ = try await transport.call(
      "app.wake", payload: WireLocalRpcEnvelopePayload(wakeIntentId: intent.value))
  }
}

enum InteractiveSession: String, Sendable {
  case available, locked
  case loginWindow = "login_window"

  static func current() -> InteractiveSession {
    guard let info = CGSessionCopyCurrentDictionary() as? [String: Any],
      (info[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid(),
      info[kCGSessionOnConsoleKey as String] as? Bool == true,
      info[kCGSessionLoginDoneKey as String] as? Bool == true
    else { return .loginWindow }
    return info["CGSSessionScreenIsLocked"] as? Bool == true ? .locked : .available
  }
}

enum AppDelivery: Equatable, Sendable {
  case terminal(id: String, intent: TerminalIntentID)
  case notification(id: String, notificationID: String)

  var id: String {
    switch self {
    case .terminal(let id, _), .notification(let id, _): return id
    }
  }

  init(_ payload: WireLocalRpcEnvelopePayload) throws {
    let fields =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
    guard let id = payload.appDeliveryId else { throw WireFailure.invalidEnvelope }
    _ = try WakeIntentID(id)
    switch payload.appAction {
    case "open_terminal":
      guard
        Set(fields?.keys.map { $0 } ?? []) == [
          "app_delivery_id", "app_action", "terminal_intent_id",
        ],
        let intent = payload.terminalIntentId
      else { throw WireFailure.invalidEnvelope }
      self = .terminal(id: id, intent: try TerminalIntentID(intent))
    case "notify_attention":
      guard
        Set(fields?.keys.map { $0 } ?? []) == ["app_delivery_id", "app_action", "notification_id"],
        let notification = payload.notificationId
      else { throw WireFailure.invalidEnvelope }
      _ = try WakeIntentID(notification)
      self = .notification(id: id, notificationID: notification)
    default: throw WireFailure.invalidEnvelope
    }
  }
}

enum TerminalCommand {
  static func make(helper: URL, intent: TerminalIntentID) throws -> String {
    let path = helper.path
    guard helper.isFileURL, helper.host == nil || helper.host == "", path.hasPrefix("/"),
      path.hasSuffix("/Contents/Helpers/bfb"), helper.standardizedFileURL.path == path,
      !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    else {
      throw NativeFailure(code: "app_unavailable")
    }
    return "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "' __launch " + intent.value
  }
}

enum SignedInstallation {
  static func signingInformation(at url: URL, identifier: String) throws -> [String: Any] {
    var code: SecStaticCode?
    var requirement: SecRequirement?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
      SecRequirementCreateWithString(
        ("identifier \"" + identifier + "\" and anchor apple generic") as CFString, [], &requirement
      ) == errSecSuccess,
      SecStaticCodeCheckValidity(
        code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode), requirement)
        == errSecSuccess
    else {
      throw NativeFailure(code: "app_unavailable")
    }
    var result: CFDictionary?
    guard
      SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &result)
        == errSecSuccess,
      let information = result as? [String: Any],
      let flags = information[kSecCodeInfoFlags as String] as? UInt32, flags & 0x10000 != 0
    else {
      throw NativeFailure(code: "app_unavailable")
    }
    let entitlements = information[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
    for key in [
      "com.apple.security.get-task-allow", "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.allow-dyld-environment-variables",
    ] {
      guard entitlements[key] as? Bool != true else { throw NativeFailure(code: "app_unavailable") }
    }
    return information
  }

  static func helper(in bundle: Bundle = .main) throws -> URL {
    let app = try signingInformation(at: bundle.bundleURL, identifier: "com.qdis.bfb")
    let helper = bundle.bundleURL.appendingPathComponent("Contents/Helpers/bfb")
    let cli = try signingInformation(at: helper, identifier: "com.tenira.bfb.daemon")
    guard let team = app[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty,
      team == cli[kSecCodeInfoTeamIdentifier as String] as? String
    else { throw NativeFailure(code: "app_unavailable") }
    return helper.standardizedFileURL
  }

  static func associatedHosts(in bundle: Bundle = .main) -> Set<String> {
    guard let info = try? signingInformation(at: bundle.bundleURL, identifier: "com.qdis.bfb"),
      let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
      let domains = entitlements["com.apple.developer.associated-domains"] as? [String]
    else { return [] }
    return Set(
      domains.compactMap { domain in
        guard domain.hasPrefix("applinks:") else { return nil }
        let host = String(domain.dropFirst(9)).replacingOccurrences(of: "?mode=developer", with: "")
        guard host.utf8.count <= 253,
          host.range(of: #"\A[a-z0-9]+([.-][a-z0-9]+)+\z"#, options: .regularExpression) != nil
        else { return nil }
        return host
      })
  }
}

enum TerminalEvents {
  static let applicationURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")

  @MainActor
  static func launchApplication() async throws {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    _ = try await NSWorkspace.shared.openApplication(
      at: applicationURL, configuration: configuration)
  }

  static func permission(ask: Bool) -> OSStatus {
    let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.Terminal")
    return AEDeterminePermissionToAutomateTarget(
      target.aeDesc, AEEventClass(0x636F_7265), AEEventID(0x646F_7363), ask)
  }

  static func send(command: String) throws {
    let event = NSAppleEventDescriptor(
      eventClass: AEEventClass(0x636F_7265), eventID: AEEventID(0x646F_7363),
      targetDescriptor: NSAppleEventDescriptor(bundleIdentifier: "com.apple.Terminal"),
      returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID)
    )
    event.setParam(NSAppleEventDescriptor(string: command), forKeyword: AEKeyword(keyDirectObject))
    let options = NSAppleEventDescriptor.SendOptions(
      rawValue: UInt(kAEWaitReply | kAENeverInteract | kAEDoNotPromptForUserConsent))
    do {
      let reply = try event.sendEvent(options: options, timeout: 5)
      if let error = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)),
        error.int32Value != 0
      {
        throw NativeFailure(code: result(for: error.int32Value))
      }
    } catch let failure as NativeFailure { throw failure } catch {
      throw NativeFailure(code: result(for: Int32((error as NSError).code)))
    }
  }

  static func result(for status: Int32) -> String {
    if [Int32(errAEEventNotPermitted), Int32(errAEEventWouldRequireUserConsent)].contains(status) {
      return "consent_denied"
    }
    if status == Int32(procNotFound) { return "app_unavailable" }
    return "app_delivery_unknown"
  }
}

@MainActor
struct NativeActions {
  var session: () -> InteractiveSession = InteractiveSession.current
  var helper: () throws -> URL = { try SignedInstallation.helper() }
  var openTerminal: () async throws -> Void = TerminalEvents.launchApplication
  var emitTerminal: @Sendable (String) throws -> Void = TerminalEvents.send
  var notify: (String) async -> String = NativeNotifications.deliver

  func perform(_ delivery: AppDelivery) async -> String {
    guard session() == .available else {
      return session() == .locked ? "session_locked" : "app_unavailable"
    }
    switch delivery {
    case .terminal(_, let intent):
      do {
        let command = try TerminalCommand.make(helper: helper(), intent: intent)
        try await openTerminal()
        guard session() == .available else { return "session_locked" }
        let send = emitTerminal
        try await Task.detached(priority: .userInitiated) { try send(command) }.value
        return "terminal_opened"
      } catch let error as NativeFailure { return error.code } catch { return "app_unavailable" }
    case .notification(_, let id): return await notify(id)
    }
  }
}

enum NativeNotifications {
  static let category = "bfb.attention"
  static let action = "bfb.show-status"

  static func register() {
    let action = UNNotificationAction(identifier: action, title: "Open BFB", options: [.foreground])
    let category = UNNotificationCategory(
      identifier: category, actions: [action], intentIdentifiers: [])
    UNUserNotificationCenter.current().setNotificationCategories([category])
  }

  static func content() -> UNMutableNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = "BFB needs your attention"
    content.body = "Open BFB to review the next step."
    content.categoryIdentifier = category
    return content
  }

  static func deliver(_ id: String) async -> String {
    guard (try? WakeIntentID(id)) != nil else { return "app_unavailable" }
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    guard
      settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    else { return "notification_denied" }
    do {
      try await center.add(UNNotificationRequest(identifier: id, content: content(), trigger: nil))
      return "notification_delivered"
    } catch { return "app_unavailable" }
  }
}
