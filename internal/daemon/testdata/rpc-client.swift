// ABOUTME: Supplies a synthetic native macOS client for the daemon Unix-socket RPC contract.
// ABOUTME: Exchanges one bounded status frame without reading credentials or personal application state.

import Darwin
import Foundation

guard CommandLine.arguments.count == 2 else { exit(2) }
let socketPath = CommandLine.arguments[1].utf8CString
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
guard socketPath.count <= MemoryLayout.size(ofValue: address.sun_path) else { exit(2) }
withUnsafeMutableBytes(of: &address.sun_path) { target in
    socketPath.withUnsafeBytes { source in target.copyBytes(from: source) }
}
let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
guard descriptor >= 0 else { exit(3) }
defer { close(descriptor) }
var timeout = timeval(tv_sec: 5, tv_usec: 0)
_ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
}
guard connected == 0 else { exit(4) }
let request = "{\"schema_version\":1,\"request_id\":\"01J00000000000000000000001\",\"method\":\"daemon.status\",\"direction\":\"request\"}\n"
let bytes = Array(request.utf8)
let written = bytes.withUnsafeBytes { write(descriptor, $0.baseAddress!, $0.count) }
guard written == bytes.count else { exit(5) }
var result = Data()
var buffer = [UInt8](repeating: 0, count: 4096)
while result.count <= 65536 {
    let count = read(descriptor, &buffer, buffer.count)
    guard count > 0 else { exit(6) }
    result.append(contentsOf: buffer.prefix(count))
    if result.last == 10 {
        FileHandle.standardOutput.write(result)
        exit(0)
    }
}
exit(7)
