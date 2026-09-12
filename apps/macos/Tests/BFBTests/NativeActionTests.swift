// ABOUTME: Proves native links, Terminal commands and runner UI states remain separated.
// ABOUTME: Captures synthetic actions and typed consent/session failures without bypassing macOS dialogs.

import Foundation
import XCTest

actor FixtureRPC: LocalRPCTransport {
  struct Request: Sendable {
    let method: String
    let payload: WireLocalRpcEnvelopePayload?
  }
  var requests: [Request] = []
  var responses: [String: WireLocalRpcEnvelopePayload]
  var failures: [String: String]

  init(responses: [String: WireLocalRpcEnvelopePayload] = [:], failures: [String: String] = [:]) {
    self.responses = responses
    self.failures = failures
  }

  func call(_ method: String, payload: WireLocalRpcEnvelopePayload?) async throws
    -> WireLocalRpcEnvelope
  {
    requests.append(Request(method: method, payload: payload))
    if method == "app.poll" { try await Task.sleep(for: .milliseconds(20)) }
    if let error = failures[method] { throw NativeFailure(code: error) }
    let response = WireLocalRpcEnvelope(
      schemaVersion: 1, requestId: try LocalRPC.requestID(), method: method, direction: "response",
      payload: responses[method] ?? WireLocalRpcEnvelopePayload())
    return try WireCodec.decode(WireCodec.encode(response))
  }
}

final class CommandCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var commands: [String] = []
  func append(_ command: String) { lock.withLock { commands.append(command) } }
  func values() -> [String] { lock.withLock { commands } }
}

@MainActor
final class NativeActionTests: XCTestCase {
  private let wake = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
  private let local = "e0da52a9-d0cb-47d8-867b-e08f684b9001"

  func testWakeSourcesPreserveIdentityAndOnlyForwardWakeRPC() async throws {
    let rpc = FixtureRPC()
    let custom = try WakeLink("bfb://launch/" + wake, associatedHosts: ["launch.bfb.example"])
    let universal = try WakeLink(
      "https://launch.bfb.example/l/" + wake, associatedHosts: ["launch.bfb.example"])
    XCTAssertEqual(custom, universal)
    try await custom.forward(to: rpc)
    try await universal.forward(to: rpc)
    let calls = await rpc.requests
    XCTAssertEqual(calls.count, 2)
    for call in calls {
      XCTAssertEqual(call.method, "app.wake")
      let data = try JSONEncoder().encode(call.payload)
      let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
      XCTAssertEqual(fields, ["wake_intent_id": wake])
    }
  }

  func testMaliciousAndUnassociatedLinksAreRejected() throws {
    let links: [String] = [
      "https://evil.example/l/" + wake, "http://launch.bfb.example/l/" + wake,
      "https://launch.bfb.example.evil/l/" + wake, "https://launch.bfb.example:444/l/" + wake,
      "https://user@launch.bfb.example/l/" + wake, "bfb://launch/" + local,
      "bfb://launch//bin/zsh", "bfb://launch/" + wake + "?command=echo",
      "bfb://launch/" + wake + "#extra",
      "bfb://launch/" + wake + "/", "bfb://launch/" + wake + ";evil",
      "bfb://launch/%30" + String(wake.dropFirst()),
      "bfb://launch/" + wake + "\n", "bfb://launch/" + String(repeating: "X", count: 10000),
      "bfb://launch/$(echo bad)", "bfb://terminal/" + local,
    ]
    for text in links {
      XCTAssertThrowsError(try WakeLink(text, associatedHosts: ["launch.bfb.example"]), text)
    }
    XCTAssertThrowsError(try TerminalIntentID(wake))
    XCTAssertThrowsError(try WakeIntentID(local))
  }

  func testTerminalCommandContainsOnlyFixedHelperAndLocalUUID() async throws {
    let capture = CommandCapture()
    let helper = URL(fileURLWithPath: "/Applications/BFB's App.app/Contents/Helpers/bfb")
    let actions = NativeActions(
      session: { .available }, helper: { helper }, openTerminal: {},
      emitTerminal: { capture.append($0) },
      notify: { _ in
        XCTFail("Terminal delivery became notification")
        return "app_unavailable"
      })
    let result = await actions.perform(.terminal(id: wake, intent: try TerminalIntentID(local)))
    XCTAssertEqual(result, "terminal_opened")
    XCTAssertEqual(
      capture.values(), ["'/Applications/BFB'\\''s App.app/Contents/Helpers/bfb' __launch " + local]
    )
    XCTAssertFalse(capture.values()[0].contains(wake))
    for path in [
      "/bin/zsh", "/Applications/BFB.app/Contents/Helpers/bfb\n", "relative/Contents/Helpers/bfb",
    ] {
      let url = URL(string: path) ?? URL(fileURLWithPath: path)
      XCTAssertThrowsError(try TerminalCommand.make(helper: url, intent: TerminalIntentID(local)))
    }
  }

  func testLockedSessionAndConsentDenialNeverBypass() async throws {
    let capture = CommandCapture()
    let delivery = AppDelivery.terminal(id: wake, intent: try TerminalIntentID(local))
    for session in [InteractiveSession.locked, .loginWindow] {
      let actions = NativeActions(
        session: { session },
        helper: {
          XCTFail("locked session inspected helper")
          return URL(fileURLWithPath: "/synthetic")
        }, openTerminal: { XCTFail("locked session opened Terminal") },
        emitTerminal: { capture.append($0) })
      let result = await actions.perform(delivery)
      XCTAssertEqual(result, session == .locked ? "session_locked" : "app_unavailable")
    }
    let denied = NativeActions(
      session: { .available },
      helper: { URL(fileURLWithPath: "/Applications/BFB.app/Contents/Helpers/bfb") },
      openTerminal: {}, emitTerminal: { _ in throw NativeFailure(code: "consent_denied") })
    let result = await denied.perform(delivery)
    XCTAssertEqual(result, "consent_denied")
    XCTAssertTrue(capture.values().isEmpty)
    XCTAssertEqual(TerminalEvents.result(for: -1743), "consent_denied")
    XCTAssertEqual(TerminalEvents.result(for: -1744), "consent_denied")
    XCTAssertEqual(TerminalEvents.result(for: -1712), "app_delivery_unknown")
  }

  func testAppDeliveryCannotCarryCloudOrProviderFields() throws {
    let valid = WireLocalRpcEnvelopePayload(
      terminalIntentId: local, appDeliveryId: wake, appAction: "open_terminal")
    XCTAssertNoThrow(try AppDelivery(valid))
    var injected = valid
    injected.wakeIntentId = wake
    XCTAssertThrowsError(try AppDelivery(injected))
    injected = valid
    injected.localPath = "/synthetic/checkout"
    XCTAssertThrowsError(try AppDelivery(injected))
    injected = valid
    injected.appAction = "notify_attention"
    XCTAssertThrowsError(try AppDelivery(injected))
    let content = NativeNotifications.content()
    XCTAssertEqual(content.categoryIdentifier, NativeNotifications.category)
    XCTAssertTrue(content.userInfo.isEmpty)
    XCTAssertFalse(content.body.contains(wake))
  }

  func testModelQuitDoesNotStopDaemonOrRepeatTerminalDelivery() async throws {
    let capture = CommandCapture()
    let rpc = FixtureRPC(responses: [
      "daemon.status": WireLocalRpcEnvelopePayload(status: "running", daemonPid: 123),
      "runner.list": WireLocalRpcEnvelopePayload(enrollments: []),
      "app.poll": WireLocalRpcEnvelopePayload(
        terminalIntentId: local, appDeliveryId: wake, appAction: "open_terminal"),
    ])
    let actions = NativeActions(
      session: { .available },
      helper: { URL(fileURLWithPath: "/Applications/BFB.app/Contents/Helpers/bfb") },
      openTerminal: {}, emitTerminal: { capture.append($0) })
    let model = RunnerModel(transport: rpc, actions: actions)
    model.start()
    try await Task.sleep(for: .milliseconds(160))
    model.stop()
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(capture.values().count, 1)
    let calls = await rpc.requests
    XCTAssertFalse(calls.contains { $0.method == "daemon.stop" })
    XCTAssertTrue(
      calls.contains { $0.method == "app.complete" && $0.payload?.appResult == "terminal_opened" })
    XCTAssertTrue(model.daemonRunning)
  }

  func testDaemonAndRevocationRecoveryAreExplicit() async {
    let rpc = FixtureRPC(failures: ["daemon.status": "daemon_offline"])
    let model = RunnerModel(transport: rpc)
    await model.refresh()
    XCTAssertFalse(model.daemonRunning)
    XCTAssertEqual(model.errorCode, "daemon_offline")
    XCTAssertEqual(RunnerCopy.connection("online"), "Connected")
    XCTAssertEqual(RunnerCopy.connection("revoked"), "Access revoked")
    XCTAssertNotEqual(RunnerCopy.recovery("expired_intent"), RunnerCopy.recovery("runner_revoked"))
    XCTAssertTrue(RunnerCopy.recovery("app_delivery_unknown").contains("reconcile"))
  }

  func testPairingOpensOnlyTheRequestedWorkspaceAndOrigin() async throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let fixture = root.appendingPathComponent(
      "protocol/fixtures/v1/valid/local-rpc.l04-enrollment.json")
    let envelope = try WireCodec.decode(Data(contentsOf: fixture))
    let enrollment = try XCTUnwrap(envelope.payload?.enrollments?.first)
    let origin = enrollment.appOrigin
    let valid = origin + "/runner-enroll#synthetic-pairing-reference"
    for link in [
      valid, "https://other.synthetic.test/runner-enroll#synthetic-pairing-reference",
      origin + "/other#synthetic-pairing-reference", origin + "/runner-enroll?extra=1#reference",
      origin + "/runner-enroll", "https://user@bfb.synthetic.test/runner-enroll#reference",
    ] {
      let rpc = FixtureRPC(responses: [
        "runner.enroll": WireLocalRpcEnvelopePayload(enrollment: enrollment, enrollmentUrl: link),
        "daemon.status": WireLocalRpcEnvelopePayload(status: "running", daemonPid: 123),
        "runner.list": WireLocalRpcEnvelopePayload(enrollments: [enrollment]),
      ])
      let model = RunnerModel(transport: rpc)
      var opened: [URL] = []
      await model.enroll(
        origin: origin, workspaceID: enrollment.workspaceId, label: enrollment.deviceLabel,
        openBrowser: {
          opened.append($0)
          return true
        })
      XCTAssertEqual(opened.map(\.absoluteString), link == valid ? [valid] : [], link)
      XCTAssertEqual(model.errorCode, link == valid ? nil : "invalid_request", link)
      let calls = await rpc.requests
      XCTAssertEqual(calls.first?.method, "runner.enroll")
      XCTAssertEqual(calls.first?.payload?.workspaceId, enrollment.workspaceId)
    }
    for mismatch in ["workspace", "origin"] {
      var different = enrollment
      if mismatch == "workspace" { different.workspaceId = wake }
      if mismatch == "origin" { different.appOrigin = "https://other.synthetic.test" }
      let rpc = FixtureRPC(responses: [
        "runner.enroll": WireLocalRpcEnvelopePayload(enrollment: different, enrollmentUrl: valid)
      ])
      let model = RunnerModel(transport: rpc)
      await model.enroll(
        origin: origin, workspaceID: enrollment.workspaceId, label: enrollment.deviceLabel,
        openBrowser: { _ in
          XCTFail("Mismatched pairing opened a browser")
          return true
        })
      XCTAssertEqual(model.errorCode, "invalid_request")
    }
  }

  func testInstallerBoundsTimeAndOutputWithoutWaitingForPipeEOF() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    try await DaemonInstallation.run(
      helper: URL(fileURLWithPath: "/usr/bin/true"), directory: directory)
    for helper in ["/usr/bin/false", "/usr/bin/yes"] {
      do {
        try await DaemonInstallation.run(helper: URL(fileURLWithPath: helper), directory: directory)
        XCTFail("Failed or unbounded installer was accepted")
      } catch let error as NativeFailure { XCTAssertEqual(error.code, "install_failed") }
    }
    let helper = directory.appendingPathComponent("synthetic-installer")
    try Data("#!/bin/sh\nexec /bin/sleep 30\n".utf8).write(to: helper)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
    let started = ContinuousClock.now
    do {
      try await DaemonInstallation.run(
        helper: helper, directory: directory, timeout: .milliseconds(50))
      XCTFail("Hung installer did not time out")
    } catch let error as NativeFailure { XCTAssertEqual(error.code, "install_timed_out") }
    XCTAssertLessThan(started.duration(to: .now), .seconds(2))
  }
}
