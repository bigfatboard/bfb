// ABOUTME: Exchanges correlated Local RPC frames with the private per-user daemon socket.
// ABOUTME: Checks filesystem and kernel ownership with bounded cancellable I/O off the UI thread.

import Darwin
import Foundation
import Security

struct NativeFailure: Error, Equatable {
  let code: String
}

protocol LocalRPCTransport: Sendable {
  func call(_ method: String, payload: WireLocalRpcEnvelopePayload?) async throws
    -> WireLocalRpcEnvelope
}

struct LocalRPC: LocalRPCTransport {
  let directory: URL

  static func installed() -> LocalRPC {
    #if DEBUG
      // Only a locally built, signed test bundle can choose isolated acceptance state.
      if let value = Bundle.main.object(forInfoDictionaryKey: "BFBTestStateDirectory") as? String {
        return LocalRPC(directory: URL(fileURLWithPath: value, isDirectory: true))
      }
    #endif
    let directory = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/BFB", isDirectory: true)
    return LocalRPC(directory: directory)
  }

  func call(_ method: String, payload: WireLocalRpcEnvelopePayload? = nil) async throws
    -> WireLocalRpcEnvelope
  {
    let operation = Task.detached(priority: .utility) {
      try exchange(method, payload: payload)
    }
    return try await withTaskCancellationHandler {
      try await operation.value
    } onCancel: {
      operation.cancel()
    }
  }

  private func exchange(_ method: String, payload: WireLocalRpcEnvelopePayload?) throws
    -> WireLocalRpcEnvelope
  {
    let request = WireLocalRpcEnvelope(
      schemaVersion: 1, requestId: try Self.requestID(), method: method, direction: "request",
      payload: payload)
    let bytes = try WireCodec.encode(request)
    let path = directory.appendingPathComponent("daemon.sock").path
    guard Self.privateObject(directory.path, type: S_IFDIR),
      Self.privateObject(path, type: S_IFSOCK)
    else {
      throw NativeFailure(code: "daemon_offline")
    }
    var address = sockaddr_un()
    let pathBytes = path.utf8CString
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      throw NativeFailure(code: "unsafe_state")
    }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { target in
      pathBytes.withUnsafeBytes { target.copyBytes(from: $0) }
    }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw NativeFailure(code: "daemon_offline") }
    defer { close(descriptor) }
    guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0, fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0
    else {
      throw NativeFailure(code: "daemon_offline")
    }
    var noSignal: Int32 = 1
    guard
      setsockopt(
        descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0
    else {
      throw NativeFailure(code: "daemon_offline")
    }
    let deadline = DispatchTime.now().uptimeNanoseconds + 8_000_000_000
    let connected = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if connected != 0 {
      guard errno == EINPROGRESS else { throw NativeFailure(code: "daemon_offline") }
      try Self.ready(descriptor, events: Int16(POLLOUT), deadline: deadline)
      var status: Int32 = 0
      var size = socklen_t(MemoryLayout<Int32>.size)
      guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &status, &size) == 0, status == 0 else {
        throw NativeFailure(code: "daemon_offline")
      }
    }
    var uid: uid_t = 0
    var gid: gid_t = 0
    var pid: Int32 = 0
    var pidSize = socklen_t(MemoryLayout<Int32>.size)
    guard getpeereid(descriptor, &uid, &gid) == 0, uid == getuid(),
      getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidSize) == 0, pid > 0
    else {
      throw NativeFailure(code: "peer_denied")
    }
    var sent = 0
    while sent < bytes.count {
      try Self.ready(descriptor, events: Int16(POLLOUT), deadline: deadline)
      let count = bytes.withUnsafeBytes {
        Darwin.write(descriptor, $0.baseAddress!.advanced(by: sent), bytes.count - sent)
      }
      if count < 0 && [EINTR, EAGAIN].contains(errno) { continue }
      guard count > 0 else { throw NativeFailure(code: "daemon_offline") }
      sent += count
    }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while result.count < 65536 {
      try Self.ready(descriptor, events: Int16(POLLIN), deadline: deadline)
      let count = Darwin.read(descriptor, &buffer, buffer.count)
      if count < 0 && [EINTR, EAGAIN].contains(errno) { continue }
      guard count > 0 else { throw NativeFailure(code: "daemon_offline") }
      result.append(contentsOf: buffer.prefix(count))
      if let newline = result.firstIndex(of: 10) {
        guard newline == result.count - 1, result.count <= 65536 else {
          throw WireFailure.invalidEnvelope
        }
        let response = try WireCodec.decode(result)
        guard response.direction == "response", response.method == method,
          response.requestId == request.requestId
        else {
          throw WireFailure.invalidEnvelope
        }
        if let error = response.error { throw NativeFailure(code: error.code) }
        return response
      }
    }
    throw WireFailure.invalidEnvelope
  }

  private static func ready(_ descriptor: Int32, events: Int16, deadline: UInt64) throws {
    while true {
      try Task.checkCancellation()
      guard DispatchTime.now().uptimeNanoseconds < deadline else {
        throw NativeFailure(code: "daemon_offline")
      }
      var item = pollfd(fd: descriptor, events: events, revents: 0)
      let count = poll(&item, 1, 100)
      if count < 0 && errno == EINTR { continue }
      guard count >= 0, item.revents & Int16(POLLNVAL | POLLERR) == 0 else {
        throw NativeFailure(code: "daemon_offline")
      }
      if count > 0 { return }
    }
  }

  private static func privateObject(_ path: String, type: mode_t) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && info.st_mode & S_IFMT == type && info.st_uid == getuid()
      && info.st_mode & 0o077 == 0
  }

  static func requestID() throws -> String {
    var data = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, data.count, &data) == errSecSuccess else {
      throw WireFailure.invalidEnvelope
    }
    var timestamp = UInt64(Date().timeIntervalSince1970 * 1000)
    for index in (0..<6).reversed() {
      data[index] = UInt8(timestamp & 255)
      timestamp >>= 8
    }
    let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    return String(
      (0..<26).map { index in
        var value = 0
        for bit in 0..<5 {
          let position = index * 5 + bit - 2
          value <<= 1
          if position >= 0 { value |= Int((data[position / 8] >> (7 - position % 8)) & 1) }
        }
        return alphabet[value]
      })
  }
}
