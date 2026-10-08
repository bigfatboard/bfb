// ABOUTME: Exercises the native app's actual Codable decoder against shared protocol fixtures.
// ABOUTME: Proves hostile data cannot silently change required fields or numeric identities.

import XCTest

final class BFBTests: XCTestCase {
  func testLocalRPCGoldenCorpus() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let fixtures = root.appendingPathComponent("protocol/fixtures/v1")
    struct Matrix: Decodable {
      struct Entry: Decodable {
        let path: String
        let schema: String
        let expect: String
      }
      let fixtures: [Entry]
    }
    let matrix = try JSONDecoder().decode(
      Matrix.self, from: Data(contentsOf: fixtures.appendingPathComponent("matrix.json")))
    let entries = matrix.fixtures.filter { $0.schema == "local-rpc" }
    XCTAssertGreaterThan(entries.count, 10)
    for entry in entries {
      let data = try Data(contentsOf: fixtures.appendingPathComponent(entry.path))
      if entry.expect == "accept" {
        let decoded = try WireCodec.decode(data)
        XCTAssertEqual(decoded.schemaVersion, 1, entry.path)
        XCTAssertNoThrow(try WireCodec.decode(WireCodec.encode(decoded)), entry.path)
      } else {
        XCTAssertThrowsError(try WireCodec.decode(data), entry.path)
      }
    }
  }

  func testDuplicateUnicodeAndExactNumberGuards() throws {
    let suffix =
      #", "request_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","method":"daemon.status","direction":"request"}"#
    for version in ["1", "1.0", "1e0", "10e-1", "1." + String(repeating: "0", count: 400)] {
      XCTAssertNoThrow(
        try WireCodec.decode(Data(("{\"schema_version\":" + version + suffix).utf8)), version)
    }
    for version in [
      "2", "true", "1.0000000000000000000001", "1e999999999", "1e-999999999", "1e309", "1e-325",
      "01", "+1",
    ] {
      XCTAssertThrowsError(
        try WireCodec.decode(Data(("{\"schema_version\":" + version + suffix).utf8)), version)
    }
    for prefix in [
      #"{"schema_version":1,"schema_version":1"#, #"{"schema_version":1,"\u0073chema_version":1"#,
      #"{"schema_version":1,"\ud800":null"#, #"{"schema_version":1,"\udfff":null"#,
    ] {
      XCTAssertThrowsError(try WireCodec.decode(Data((prefix + suffix).utf8)))
    }
    XCTAssertThrowsError(try WireCodec.decode(Data([0xFF])))
    XCTAssertThrowsError(try WireCodec.decode(Data(repeating: 32, count: 65537)))
  }
}
