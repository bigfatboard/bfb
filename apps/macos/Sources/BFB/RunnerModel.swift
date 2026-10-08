// ABOUTME: Presents daemon-owned runner status and browser enrollment in the native app.
// ABOUTME: Polls narrow UI deliveries independently of the daemon's background execution lifecycle.

import AppKit
import Darwin
import Foundation
import UserNotifications

@MainActor
final class RunnerModel: ObservableObject {
  @Published private(set) var daemonRunning = false
  @Published private(set) var enrollments: [WireRunnerLocalEnrollment] = []
  @Published private(set) var errorCode: String?
  @Published private(set) var notice: String?
  @Published private(set) var busy = false
  @Published private(set) var session = InteractiveSession.current()

  let transport: any LocalRPCTransport
  private let actions: NativeActions
  private var monitoring: Task<Void, Never>?
  private var receiving: Task<Void, Never>?
  private var pendingAcknowledgement: (id: String, result: String)?
  private var results: [String: String] = [:]
  private var resultOrder: [String] = []

  init(
    transport: any LocalRPCTransport = LocalRPC.installed(),
    actions: NativeActions = NativeActions()
  ) {
    self.transport = transport
    self.actions = actions
  }

  func start() {
    guard monitoring == nil else { return }
    monitoring = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        try? await Task.sleep(for: .seconds(3))
      }
    }
    receiving = Task { [weak self] in
      while !Task.isCancelled {
        do { try await self?.receive() } catch {
          if !Task.isCancelled {
            self?.report(error)
            try? await Task.sleep(for: .seconds(2))
          }
        }
        try? await Task.sleep(for: .milliseconds(100))
      }
    }
  }

  func stop() {
    monitoring?.cancel()
    receiving?.cancel()
    monitoring = nil
    receiving = nil
    // Closing the app never calls daemon.stop or signals an execution process.
  }

  func refresh() async {
    session = actions.session()
    do {
      let status = try await transport.call("daemon.status", payload: nil)
      guard status.payload?.status == "running", status.payload?.daemonPid != nil else {
        throw WireFailure.invalidEnvelope
      }
      daemonRunning = true
      let response = try await transport.call("runner.list", payload: nil)
      guard let enrollments = response.payload?.enrollments else {
        throw WireFailure.invalidEnvelope
      }
      self.enrollments = enrollments
      if errorCode == "daemon_offline" { errorCode = nil }
    } catch {
      daemonRunning = false
      enrollments = []
      report(error)
    }
  }

  func handleLink(_ url: URL, associatedHosts: Set<String> = SignedInstallation.associatedHosts())
    async
  {
    do {
      let link = try WakeLink(url.absoluteString, associatedHosts: associatedHosts)
      try await link.forward(to: transport)
      notice = "Launch request forwarded to the runner."
      errorCode = nil
    } catch { report(error) }
  }

  func enroll(
    origin: String, workspaceID: String, label: String,
    openBrowser: (URL) -> Bool = { NSWorkspace.shared.open($0) }
  ) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      _ = try WakeIntentID(workspaceID)
      let response = try await transport.call(
        "runner.enroll",
        payload: WireLocalRpcEnvelopePayload(
          workspaceId: workspaceID, appOrigin: origin, deviceLabel: label))
      guard let enrollment = response.payload?.enrollment, enrollment.workspaceId == workspaceID,
        enrollment.appOrigin == origin, let text = response.payload?.enrollmentUrl,
        let url = URL(string: text), let base = URLComponents(string: origin),
        let link = URLComponents(url: url, resolvingAgainstBaseURL: false),
        base.scheme == "https", base.path.isEmpty, base.user == nil, base.password == nil,
        base.query == nil, base.fragment == nil,
        link.scheme == base.scheme, link.host == base.host, link.port == base.port,
        link.user == nil, link.password == nil, link.path == "/runner-enroll", link.query == nil,
        link.fragment?.isEmpty == false, openBrowser(url)
      else { throw WireFailure.invalidEnvelope }
      notice = "Approve this Mac in your browser. Its connection status will update here."
      errorCode = nil
      await refresh()
    } catch { report(error) }
  }

  func reconnect(_ enrollment: WireRunnerLocalEnrollment) async {
    do {
      _ = try await transport.call(
        "runner.wake", payload: WireLocalRpcEnvelopePayload(runnerId: enrollment.runnerId))
      errorCode = nil
      await refresh()
    } catch { report(error) }
  }

  func forget(_ enrollment: WireRunnerLocalEnrollment) async {
    guard enrollment.connectionState == "revoked" else { return }
    do {
      _ = try await transport.call(
        "runner.forget", payload: WireLocalRpcEnvelopePayload(runnerId: enrollment.runnerId))
      errorCode = nil
      await refresh()
    } catch { report(error) }
  }

  func installDaemon() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let helper = try SignedInstallation.helper()
      try await Task.detached(priority: .userInitiated) {
        try await DaemonInstallation.run(helper: helper, directory: LocalRPC.installed().directory)
      }.value
      errorCode = nil
      await refresh()
    } catch { report(error) }
  }

  func requestTerminalConsent() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    guard actions.session() == .available else {
      errorCode = "session_locked"
      return
    }
    do {
      try await TerminalEvents.launchApplication()
      let status = await Task.detached { TerminalEvents.permission(ask: true) }.value
      if status == 0 {
        errorCode = nil
        notice = "Terminal access is enabled."
      } else {
        errorCode = TerminalEvents.result(for: status)
      }
    } catch { report(error) }
  }

  func requestNotifications() async {
    do {
      let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .sound,
      ])
      if allowed {
        errorCode = nil
        notice = "BFB notifications are enabled."
      } else {
        errorCode = "notification_denied"
      }
    } catch { report(error) }
  }

  private func receive() async throws {
    if let pending = pendingAcknowledgement {
      do {
        _ = try await transport.call(
          "app.complete",
          payload: WireLocalRpcEnvelopePayload(appDeliveryId: pending.id, appResult: pending.result)
        )
        pendingAcknowledgement = nil
      } catch let error as NativeFailure where error.code == "expired_intent" {
        pendingAcknowledgement = nil
        report(error)
      }
      return
    }
    let response = try await transport.call(
      "app.poll", payload: WireLocalRpcEnvelopePayload(appSessionState: actions.session().rawValue))
    guard let payload = response.payload, payload.appAction != nil else { return }
    let delivery = try AppDelivery(payload)
    let result: String
    if let previous = results[delivery.id] {
      result = previous
    } else {
      result = await actions.perform(delivery) {
        _ = try await self.transport.call(
          "app.focus_check", payload: WireLocalRpcEnvelopePayload(appDeliveryId: delivery.id))
      }
      results[delivery.id] = result
      resultOrder.append(delivery.id)
      if resultOrder.count > 256 { results.removeValue(forKey: resultOrder.removeFirst()) }
    }
    pendingAcknowledgement = (delivery.id, result)
    if result != "terminal_opened" && result != "terminal_focused"
      && result != "notification_delivered"
    {
      errorCode = result
    }
  }

  private func report(_ error: Error) {
    if error is CancellationError { return }
    errorCode = (error as? NativeFailure)?.code ?? "invalid_request"
    notice = nil
  }
}

enum DaemonInstallation {
  static func run(helper: URL, directory: URL, timeout: Duration = .seconds(15)) async throws {
    let process = Process()
    process.executableURL = helper
    process.arguments = ["--data-dir", directory.path, "daemon", "install"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    let descriptor = output.fileHandleForReading.fileDescriptor
    guard fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 else {
      throw NativeFailure(code: "install_failed")
    }
    defer {
      // Stop only this installer, never the independently installed launchd daemon.
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      try? output.fileHandleForReading.close()
      try? output.fileHandleForWriting.close()
    }
    try process.run()
    let deadline = ContinuousClock.now.advanced(by: timeout)
    var buffer = [UInt8](repeating: 0, count: 4096)
    var bytes = 0
    while true {
      try Task.checkCancellation()
      guard ContinuousClock.now < deadline else { throw NativeFailure(code: "install_timed_out") }
      while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count > 0 {
          bytes += count
          guard bytes <= 65536 else { throw NativeFailure(code: "install_failed") }
        } else if count == 0 || errno == EAGAIN {
          break
        } else if errno != EINTR {
          throw NativeFailure(code: "install_failed")
        }
      }
      if !process.isRunning {
        guard process.terminationStatus == 0 else { throw NativeFailure(code: "install_failed") }
        return
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }
}

enum RunnerCopy {
  static func connection(_ state: String) -> String {
    switch state {
    case "key_pending": return "Waiting for Keychain"
    case "pending_approval": return "Waiting for browser approval"
    case "connecting": return "Connecting"
    case "online": return "Connected"
    case "offline": return "Offline"
    case "credential_unavailable": return "Keychain unavailable"
    case "sync_blocked": return "Inventory needs attention"
    case "authorization_required": return "Access needs renewal"
    case "revoked": return "Access revoked"
    default: return "Status unavailable"
    }
  }

  static func recovery(_ code: String) -> String {
    switch code {
    case "daemon_offline": return "The runner is unavailable. Choose Start runner, then retry."
    case "install_failed":
      return
        "The runner could not be installed. Check the signed BFB installation; existing state was preserved."
    case "install_timed_out":
      return "Runner installation timed out. Check its connection status before retrying."
    case "app_unavailable":
      return "Install a signed BFB app with its bundled runner and sign in to this Mac."
    case "session_locked": return "Unlock this Mac to open an interactive session."
    case "consent_denied":
      return "Allow BFB to control Terminal in System Settings → Privacy & Security → Automation."
    case "notification_denied": return "Allow BFB in System Settings → Notifications."
    case "expired_intent":
      return "This launch or app delivery has expired. Start again from the task."
    case "revoked", "runner_revoked":
      return
        "This Mac’s workspace access was revoked. Remove the revoked connection and enroll again."
    case "runner_credential_unavailable":
      return "Unlock the login Keychain and check the signed runner installation."
    case "runner_authorization_required":
      return "Approve this Mac in your browser or ask a workspace owner to renew its grant."
    case "app_delivery_unknown":
      return
        "Terminal delivery was not acknowledged. The runner must reconcile the intent before retrying."
    case "peer_denied":
      return "The app and runner must be signed BFB components from the same installation team."
    case "not_implemented": return "This runner does not support that operation yet."
    default:
      return
        "BFB could not validate this request. Check the input and the app/runner versions, then retry."
    }
  }
}
