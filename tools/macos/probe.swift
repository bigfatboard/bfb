// ABOUTME: Exercises the app's compiled transport and signature checks in native acceptance.
// ABOUTME: Reports bounded synthetic outcomes without rendering private diagnostics or requesting consent.

import AppKit
import Foundation

@main
struct NativeAcceptanceProbe {
  static func main() async {
    do {
      let arguments = CommandLine.arguments
      if arguments.count == 3 && arguments[1] == "locate" {
        let path = URL(fileURLWithPath: arguments[2]).resolvingSymlinksInPath().path
        let pid = await MainActor.run {
          NSWorkspace.shared.runningApplications.first {
            // LaunchServices can still enumerate a process after the kernel reports its exit.
            $0.bundleURL?.resolvingSymlinksInPath().path == path
              && $0.processIdentifier > 0 && kill($0.processIdentifier, 0) == 0
          }?.processIdentifier ?? 0
        }
        try emit(["ok": true, "pid": pid])
        return
      }
      if arguments.count == 4 && arguments[1] == "terminate" {
        guard let pid = Int32(arguments[2]) else { throw WireFailure.invalidEnvelope }
        let stopped = await MainActor.run {
          guard let app = NSRunningApplication(processIdentifier: pid),
            app.bundleURL?.resolvingSymlinksInPath().path
              == URL(fileURLWithPath: arguments[3]).resolvingSymlinksInPath().path
          else { return false }
          return app.terminate()
        }
        try emit(["ok": stopped])
        return
      }
      if arguments.count == 3 && arguments[1] == "cancel" {
        let operation = Task {
          try await LocalRPC(directory: URL(fileURLWithPath: arguments[2])).call("daemon.status")
        }
        try await Task.sleep(for: .milliseconds(100))
        operation.cancel()
        _ = try await operation.value
        throw WireFailure.invalidEnvelope
      }
      if arguments.count == 3 && arguments[1] == "installation" {
        guard let bundle = Bundle(url: URL(fileURLWithPath: arguments[2])) else {
          throw WireFailure.invalidEnvelope
        }
        let helper = try SignedInstallation.helper(in: bundle)
        try emit([
          "ok": true, "helper_name": helper.lastPathComponent,
          "hosts": SignedInstallation.associatedHosts(in: bundle).sorted(),
        ])
        return
      }
      guard arguments.count == 4 || arguments.count == 5, arguments[1] == "call" else {
        throw WireFailure.invalidEnvelope
      }
      var payload: WireLocalRpcEnvelopePayload?
      if arguments.count == 5 {
        let object = try JSONSerialization.jsonObject(with: Data(arguments[4].utf8))
        let envelope: [String: Any] = [
          "schema_version": 1, "request_id": try LocalRPC.requestID(), "method": arguments[3],
          "direction": "request", "payload": object,
        ]
        payload = try WireCodec.decode(JSONSerialization.data(withJSONObject: envelope)).payload
      }
      let response = try await LocalRPC(
        directory: URL(fileURLWithPath: arguments[2], isDirectory: true)
      ).call(arguments[3], payload: payload)
      FileHandle.standardOutput.write(try WireCodec.encode(response))
    } catch is CancellationError { try? emit(["ok": false, "code": "cancelled"]) } catch let error
      as NativeFailure
    { try? emit(["ok": false, "code": error.code]) } catch {
      try? emit(["ok": false, "code": "invalid_request"])
    }
  }

  private static func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(
      try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
  }
}
