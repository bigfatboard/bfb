// ABOUTME: Proves the BFB macOS XCTest target loads and executes in CI.
// ABOUTME: Product behavior tests are introduced with their owning work packages.

import XCTest

final class BFBTests: XCTestCase {
  func testFoundationTargetLoads() {
    XCTAssertTrue(true)
  }
}
