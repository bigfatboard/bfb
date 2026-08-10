// ABOUTME: Provides the compile-safe entry point for the native BFB macOS target.
// ABOUTME: Menu-bar and runner behavior is introduced by later owning work packages.

import SwiftUI

@main
struct BFBApplication: App {
  var body: some Scene {
    Settings {
      EmptyView()
    }
  }
}
