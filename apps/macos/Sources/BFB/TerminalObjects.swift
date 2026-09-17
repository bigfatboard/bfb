// ABOUTME: Addresses existing Terminal tabs by local intent tag and native TTY using typed Apple events.
// ABOUTME: Uses predicate-based mutations and never reads terminal content, runs AppleScript, or falls back to a frontmost tab.

import AppKit
import CoreServices
import Foundation

struct TerminalEndpoint: Sendable, Equatable {
  let pid: pid_t
  let launchedAt: Date

  static func current() throws -> TerminalEndpoint {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Terminal")
    guard apps.count == 1, let app = apps.first, let launchedAt = app.launchDate,
      app.bundleURL?.standardizedFileURL == TerminalEvents.applicationURL, !app.isTerminated
    else { throw NativeFailure(code: "app_unavailable") }
    return TerminalEndpoint(pid: app.processIdentifier, launchedAt: launchedAt)
  }

  func check() throws {
    guard try Self.current() == self else { throw NativeFailure(code: "app_unavailable") }
  }
}

struct TerminalSelection: Sendable, Equatable {
  let endpoint: TerminalEndpoint
  let windowID: Int32
  let focus: TerminalFocus
}

struct TerminalFocus: Equatable, Sendable {
  let intent: TerminalIntentID
  let tty: String
  let authorizedAt: Date
  let expiresAt: Date

  init(_ input: WireLocalExecutionFocus) throws {
    var parser = try WireJSONParser(JSONEncoder().encode(input))
    guard
      try WireSchemaValidator().accepts(
        parser.parse(), schema: .object(["$ref": .string("local-execution-focus.json")]))
    else {
      throw WireFailure.invalidEnvelope
    }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    guard
      let authorized = fractional.date(from: input.authorizedAt)
        ?? plain.date(from: input.authorizedAt),
      let expires = fractional.date(from: input.expiresAt) ?? plain.date(from: input.expiresAt),
      authorized < expires
    else { throw WireFailure.invalidEnvelope }
    intent = try TerminalIntentID(input.terminalIntentId)
    tty = input.tty
    authorizedAt = authorized
    expiresAt = expires
  }

  func check(at now: Date) throws {
    guard now >= authorizedAt, now.timeIntervalSince(authorizedAt) <= 5, now < expiresAt else {
      throw NativeFailure(code: "expired_intent")
    }
  }
}

enum TerminalFocusStep: CaseIterable, Sendable {
  case select, unminimize, raise, verify

  func perform(_ selection: TerminalSelection) throws {
    switch self {
    case .select: try TerminalObjects.select(selection)
    case .unminimize: try TerminalObjects.unminimize(selection)
    case .raise: try TerminalObjects.raise(selection)
    case .verify: try TerminalObjects.verify(selection)
    }
  }
}

enum TerminalObjects {
  // Terminal.app's installed scripting dictionary defines these tab/window properties.
  static let tabClass: OSType = 0x7474_6162  // ttab
  static let ttyProperty: OSType = 0x7474_7479  // ttty
  static let titleProperty: OSType = 0x7469_746C  // titl
  static let customTitleVisible: OSType = 0x7464_6374  // tdct
  static let selectedProperty: OSType = 0x7462_736C  // tbsl
  static let selectedTab: OSType = 0x7463_6E74  // tcnt

  static func object(
    _ kind: OSType, in container: NSAppleEventDescriptor = .null(), form: OSType,
    key: NSAppleEventDescriptor
  ) throws -> NSAppleEventDescriptor {
    let record = NSAppleEventDescriptor.record()
    record.setDescriptor(
      NSAppleEventDescriptor(typeCode: kind), forKeyword: AEKeyword(keyAEDesiredClass))
    record.setDescriptor(container, forKeyword: AEKeyword(keyAEContainer))
    record.setDescriptor(
      NSAppleEventDescriptor(enumCode: form), forKeyword: AEKeyword(keyAEKeyForm))
    record.setDescriptor(key, forKeyword: AEKeyword(keyAEKeyData))
    guard let result = record.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else {
      throw NativeFailure(code: "app_delivery_unknown")
    }
    return result
  }

  static func property(_ code: OSType, of object: NSAppleEventDescriptor) throws
    -> NSAppleEventDescriptor
  {
    try self.object(
      OSType(cProperty), in: object, form: OSType(formPropertyID),
      key: NSAppleEventDescriptor(typeCode: code))
  }

  static func all(_ kind: OSType, in container: NSAppleEventDescriptor = .null()) throws
    -> NSAppleEventDescriptor
  {
    // The absolute-ordinal key is built directly: coercing a type descriptor
    // to an absolute ordinal is not handled on current macOS releases.
    var code = OSType(kAEAll).bigEndian
    let ordinalData = withUnsafeBytes(of: &code) { Data($0) }
    guard
      let ordinal = NSAppleEventDescriptor(
        descriptorType: DescType(typeAbsoluteOrdinal), data: ordinalData)
    else {
      throw NativeFailure(code: "app_delivery_unknown")
    }
    return try object(kind, in: container, form: OSType(formAbsolutePosition), key: ordinal)
  }

  static func equal(_ left: NSAppleEventDescriptor, _ right: NSAppleEventDescriptor) throws
    -> NSAppleEventDescriptor
  {
    let record = NSAppleEventDescriptor.record()
    record.setDescriptor(
      NSAppleEventDescriptor(enumCode: OSType(kAEEquals)), forKeyword: AEKeyword(keyAECompOperator))
    record.setDescriptor(left, forKeyword: AEKeyword(keyAEObject1))
    record.setDescriptor(right, forKeyword: AEKeyword(keyAEObject2))
    guard let result = record.coerce(toDescriptorType: DescType(typeCompDescriptor)) else {
      throw NativeFailure(code: "app_delivery_unknown")
    }
    return result
  }

  static func and(_ terms: [NSAppleEventDescriptor]) throws -> NSAppleEventDescriptor {
    let list = NSAppleEventDescriptor.list()
    for term in terms { list.insert(term, at: 0) }
    let record = NSAppleEventDescriptor.record()
    record.setDescriptor(
      NSAppleEventDescriptor(enumCode: OSType(kAEAND)), forKeyword: AEKeyword(keyAELogicalOperator))
    record.setDescriptor(list, forKeyword: AEKeyword(keyAELogicalTerms))
    guard let result = record.coerce(toDescriptorType: DescType(typeLogicalDescriptor)) else {
      throw NativeFailure(code: "app_delivery_unknown")
    }
    return result
  }

  static func examined() throws -> NSAppleEventDescriptor {
    guard
      let result = NSAppleEventDescriptor(
        descriptorType: DescType(typeObjectBeingExamined), data: Data())
    else {
      throw NativeFailure(code: "app_delivery_unknown")
    }
    return result
  }

  static func window(_ id: Int32) throws -> NSAppleEventDescriptor {
    guard id > 0 else { throw NativeFailure(code: "app_unavailable") }
    return try object(
      OSType(cWindow), form: OSType(formUniqueID), key: NSAppleEventDescriptor(int32: id))
  }

  static func tab(_ selection: TerminalSelection) throws -> NSAppleEventDescriptor {
    let candidate = try examined()
    return try object(
      tabClass, in: window(selection.windowID), form: OSType(formTest),
      key: and([
        equal(
          property(ttyProperty, of: candidate), NSAppleEventDescriptor(string: selection.focus.tty)),
        equal(
          property(titleProperty, of: candidate),
          NSAppleEventDescriptor(string: selection.focus.intent.value)),
      ]))
  }

  // The selected-tab predicate is resolved by Terminal in the same event as
  // each window mutation. Closing or moving the tab cannot target its replacement.
  static func selectedWindow(_ selection: TerminalSelection) throws -> NSAppleEventDescriptor {
    let candidate = try examined()
    let selected = try property(selectedTab, of: candidate)
    return try object(
      OSType(cWindow), form: OSType(formTest),
      key: and([
        equal(
          property(OSType(pID), of: candidate), NSAppleEventDescriptor(int32: selection.windowID)),
        equal(
          property(ttyProperty, of: selected), NSAppleEventDescriptor(string: selection.focus.tty)),
        equal(
          property(titleProperty, of: selected),
          NSAppleEventDescriptor(string: selection.focus.intent.value)),
      ]))
  }

  static func send(
    _ endpoint: TerminalEndpoint, eventID: OSType, direct: NSAppleEventDescriptor,
    value: NSAppleEventDescriptor? = nil
  ) throws -> NSAppleEventDescriptor {
    try endpoint.check()
    if eventID != OSType(kAEGetData), InteractiveSession.current() != .available {
      throw NativeFailure(code: "session_locked")
    }
    let event = NSAppleEventDescriptor(
      eventClass: AEEventClass(kAECoreSuite), eventID: eventID,
      targetDescriptor: NSAppleEventDescriptor(processIdentifier: endpoint.pid),
      returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID)
    )
    event.setParam(direct, forKeyword: AEKeyword(keyDirectObject))
    if let value { event.setParam(value, forKeyword: AEKeyword(keyAEData)) }
    let options = NSAppleEventDescriptor.SendOptions(
      rawValue: UInt(kAEWaitReply | kAENeverInteract | kAEDoNotPromptForUserConsent))
    do {
      let reply = try event.sendEvent(options: options, timeout: 1)
      if let error = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)),
        error.int32Value != 0
      {
        throw NativeFailure(code: TerminalEvents.result(for: error.int32Value))
      }
      do { try endpoint.check() } catch { throw NativeFailure(code: "app_delivery_unknown") }
      return reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) ?? .null()
    } catch let failure as NativeFailure { throw failure } catch {
      throw NativeFailure(code: TerminalEvents.result(for: Int32((error as NSError).code)))
    }
  }

  static func get(_ endpoint: TerminalEndpoint, _ object: NSAppleEventDescriptor) throws
    -> NSAppleEventDescriptor
  {
    try send(endpoint, eventID: OSType(kAEGetData), direct: object)
  }

  static func set(
    _ endpoint: TerminalEndpoint, _ object: NSAppleEventDescriptor, _ value: NSAppleEventDescriptor
  ) throws {
    _ = try send(endpoint, eventID: OSType(kAESetData), direct: object, value: value)
  }

  static func items(_ list: NSAppleEventDescriptor, limit: Int) throws -> [NSAppleEventDescriptor] {
    guard list.descriptorType == DescType(typeAEList), list.numberOfItems <= limit else {
      throw NativeFailure(code: "app_unavailable")
    }
    if list.numberOfItems == 0 { return [] }
    return try (1...list.numberOfItems).map {
      guard let item = list.atIndex($0) else { throw NativeFailure(code: "app_delivery_unknown") }
      return item
    }
  }

  static func windowIDs(_ endpoint: TerminalEndpoint) throws -> [Int32] {
    let ids = try items(get(endpoint, property(OSType(pID), of: all(OSType(cWindow)))), limit: 128)
      .map { $0.int32Value }
    guard ids.allSatisfy({ $0 > 0 }), Set(ids).count == ids.count else {
      throw NativeFailure(code: "app_unavailable")
    }
    return ids
  }

  static func open(command: String, intent: TerminalIntentID) throws {
    let endpoint = try TerminalEndpoint.current()
    let existing = try windowIDs(endpoint)
    let created = try send(
      endpoint, eventID: 0x646F_7363, direct: NSAppleEventDescriptor(string: command))
    do {
      try tag(created, endpoint: endpoint, intent: intent, existing: existing)
    } catch {
      // The bootstrap was already sent. A metadata error is not evidence that
      // no Terminal or supervisor exists and must never invite another open.
      throw NativeFailure(code: "app_delivery_unknown")
    }
  }

  private static func tag(
    _ created: NSAppleEventDescriptor, endpoint: TerminalEndpoint, intent: TerminalIntentID,
    existing: [Int32]
  ) throws {
    // do script without a target creates one tab in a new window. Refuse an
    // unexpected reply instead of applying the private tag to an existing window.
    guard created.descriptorType == DescType(typeObjectSpecifier),
      created.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == tabClass,
      let container = created.forKeyword(AEKeyword(keyAEContainer)),
      container.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == OSType(cWindow),
      container.forKeyword(AEKeyword(keyAEKeyForm))?.enumCodeValue == OSType(formUniqueID),
      let id = container.forKeyword(AEKeyword(keyAEKeyData))?.int32Value,
      id > 0, !existing.contains(id),
      try items(get(endpoint, all(tabClass, in: window(id))), limit: 2).count == 1,
      let tty = try get(endpoint, property(ttyProperty, of: created)).stringValue,
      tty.range(of: #"\A/dev/ttys[0-9]{3,6}\z"#, options: .regularExpression) != nil
    else { throw NativeFailure(code: "app_delivery_unknown") }
    let onlyThisTTY = try object(
      tabClass, in: window(id), form: OSType(formTest),
      key:
        equal(property(ttyProperty, of: examined()), NSAppleEventDescriptor(string: tty)))
    try set(
      endpoint, property(customTitleVisible, of: onlyThisTTY),
      NSAppleEventDescriptor(boolean: false))
    try set(
      endpoint, property(titleProperty, of: onlyThisTTY),
      NSAppleEventDescriptor(string: intent.value))
    let tags = try items(get(endpoint, property(titleProperty, of: onlyThisTTY)), limit: 1)
    guard tags.count == 1, tags[0].stringValue == intent.value else {
      throw NativeFailure(code: "app_delivery_unknown")
    }
  }

  static func find(_ focus: TerminalFocus) throws -> TerminalSelection {
    let endpoint = try TerminalEndpoint.current()
    var found: TerminalSelection?
    for id in try windowIDs(endpoint) {
      try focus.check(at: Date())
      try Task.checkCancellation()
      let selection = TerminalSelection(endpoint: endpoint, windowID: id, focus: focus)
      let matches = try items(get(endpoint, tab(selection)), limit: 1)
      if matches.isEmpty { continue }
      guard found == nil else { throw NativeFailure(code: "app_unavailable") }
      found = selection
    }
    guard let found else { throw NativeFailure(code: "app_unavailable") }
    return found
  }

  static func select(_ selection: TerminalSelection) throws {
    guard try items(get(selection.endpoint, tab(selection)), limit: 1).count == 1 else {
      throw NativeFailure(code: "app_unavailable")
    }
    try set(
      selection.endpoint, property(selectedProperty, of: tab(selection)),
      NSAppleEventDescriptor(boolean: true))
  }

  static func unminimize(_ selection: TerminalSelection) throws {
    try set(
      selection.endpoint, property(0x706D_6E64, of: selectedWindow(selection)),
      NSAppleEventDescriptor(boolean: false))  // pmnd
  }

  static func raise(_ selection: TerminalSelection) throws {
    try set(
      selection.endpoint, property(0x7069_7366, of: selectedWindow(selection)),
      NSAppleEventDescriptor(boolean: true))  // pisf
  }

  static func verify(_ selection: TerminalSelection) throws {
    let flags = try items(
      get(selection.endpoint, property(0x7069_7366, of: selectedWindow(selection))), limit: 1)
    guard flags.count == 1, flags[0].booleanValue,
      NSRunningApplication(processIdentifier: selection.endpoint.pid)?.isActive == true
    else { throw NativeFailure(code: "app_delivery_unknown") }
  }
}
