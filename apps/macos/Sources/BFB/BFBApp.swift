// ABOUTME: Provides BFB's native menu-bar status, enrollment and recovery controls.
// ABOUTME: Receives opaque system links while leaving credentials and execution in the daemon.

import AppKit
import SwiftUI
import UserNotifications

@main
struct BFBApplication: App {
  @NSApplicationDelegateAdaptor(BFBAppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra("BFB", systemImage: "point.3.connected.trianglepath.dotted") {
      RunnerMenu(model: delegate.model)
    }
    Window("BFB", id: "status") {
      RunnerStatusView(model: delegate.model)
    }
    .defaultSize(width: 490, height: 620)
    .windowResizability(.contentMinSize)
  }
}

@MainActor
final class BFBAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let model = RunnerModel()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NativeNotifications.register()
    UNUserNotificationCenter.current().delegate = self
    model.start()
  }

  func applicationWillTerminate(_ notification: Notification) { model.stop() }

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls.prefix(16) { Task { await model.handleLink(url) } }
  }

  func application(
    _ application: NSApplication, continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void
  ) -> Bool {
    guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
      let url = userActivity.webpageURL
    else { return false }
    Task { await model.handleLink(url) }
    return true
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let category = response.notification.request.content.categoryIdentifier
    let action = response.actionIdentifier
    if category == NativeNotifications.category
      && [NativeNotifications.action, UNNotificationDefaultActionIdentifier].contains(action)
    {
      Task { @MainActor in
        NSApp.activate(ignoringOtherApps: false)
        NSApp.windows.first(where: { $0.title == "BFB" })?.makeKeyAndOrderFront(nil)
      }
    }
    completionHandler()
  }
}

private struct RunnerMenu: View {
  @ObservedObject var model: RunnerModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Text(model.daemonRunning ? "Runner available" : "Runner unavailable")
    if model.session != .available { Text("Interactive session unavailable") }
    ForEach(model.enrollments, id: \.runnerId) { enrollment in
      Text(enrollment.deviceLabel + " · " + RunnerCopy.connection(enrollment.connectionState))
    }
    Divider()
    Button("Open BFB…") {
      openWindow(id: "status")
      NSApp.activate(ignoringOtherApps: false)
    }.keyboardShortcut("o")
    Button("Refresh status") { Task { await model.refresh() } }
    Divider()
    Button("Quit BFB") { NSApp.terminate(nil) }.keyboardShortcut("q")
    Text("The runner keeps working when BFB is closed.")
  }
}

struct RunnerStatusView: View {
  @ObservedObject var model: RunnerModel
  @State private var origin = ""
  @State private var workspaceID = ""
  @State private var deviceLabel = "This Mac"
  @State private var showEnrollment = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: "point.3.connected.trianglepath.dotted")
            .font(.system(size: 28, weight: .medium)).foregroundStyle(.tint).accessibilityHidden(
              true)
          VStack(alignment: .leading, spacing: 5) {
            Text("BFB on this Mac").font(.title2.weight(.semibold))
            Text("Runner connections and local access.").foregroundStyle(.secondary)
          }
          Spacer()
          Button {
            Task { await model.refresh() }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .help("Refresh status").accessibilityLabel("Refresh status")
        }
        VStack(alignment: .leading, spacing: 8) {
          Label(
            model.daemonRunning ? "Runner available" : "Runner unavailable",
            systemImage: model.daemonRunning ? "checkmark.circle.fill" : "exclamationmark.circle"
          )
          .font(.headline).foregroundStyle(model.daemonRunning ? Color.primary : Color.orange)
          Text("Closing BFB does not stop the runner or agent work.").font(.callout)
            .foregroundStyle(.secondary)
          if model.session != .available {
            Label(
              model.session == .locked
                ? "Mac locked — interactive launch is paused"
                : "Sign in to this Mac for interactive launch", systemImage: "lock"
            ).font(.callout)
          }
          if !model.daemonRunning {
            Button("Start runner") { Task { await model.installDaemon() } }.disabled(model.busy)
          }
        }
        if let error = model.errorCode {
          Label(RunnerCopy.recovery(error), systemImage: "exclamationmark.triangle")
            .font(.callout).fixedSize(horizontal: false, vertical: true)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8)).accessibilityIdentifier(
              "runner-recovery")
        } else if let notice = model.notice {
          Text(notice).font(.callout).foregroundStyle(.secondary).accessibilityIdentifier(
            "runner-notice")
        }
        VStack(alignment: .leading, spacing: 14) {
          HStack {
            Text("Workspaces").font(.headline)
            Spacer()
            if !model.enrollments.isEmpty { Button("Add workspace") { showEnrollment.toggle() } }
          }
          if model.enrollments.isEmpty {
            Text("Connect this Mac to a workspace. You’ll approve its access in your browser.")
              .font(.callout).foregroundStyle(.secondary)
          }
          ForEach(model.enrollments, id: \.runnerId) { enrollment in
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(enrollment.deviceLabel).fontWeight(.medium)
                Spacer()
                Text(RunnerCopy.connection(enrollment.connectionState)).font(.callout)
              }
              Text(enrollment.appOrigin).font(.callout).foregroundStyle(.secondary).textSelection(
                .enabled)
              Text("Workspace " + enrollment.workspaceId).font(.caption.monospaced())
                .foregroundStyle(.secondary).textSelection(.enabled)
              if enrollment.connectionState == "revoked" {
                Button("Remove revoked connection", role: .destructive) {
                  Task { await model.forget(enrollment) }
                }
              } else if enrollment.connectionState != "online" {
                Button("Reconnect") { Task { await model.reconnect(enrollment) } }
              }
            }
            Divider()
          }
          if !model.enrollments.isEmpty {
            Text("Connected means the runner can reach BFB. It does not indicate agent activity.")
              .font(.caption).foregroundStyle(.secondary)
          }
          if model.enrollments.isEmpty || showEnrollment { enrollmentForm }
        }
        Divider()
        VStack(alignment: .leading, spacing: 12) {
          Text("Local access").font(.headline)
          HStack {
            Button("Enable Terminal access…") { Task { await model.requestTerminalConsent() } }
            Button("Enable notifications…") { Task { await model.requestNotifications() } }
          }.disabled(model.busy)
          Text("macOS asks for your consent. Launch links never contain Terminal commands.").font(
            .caption
          ).foregroundStyle(.secondary)
        }
      }
      .padding(28).frame(maxWidth: 660, alignment: .leading)
    }
    .frame(minWidth: 460, minHeight: 520)
  }

  private var enrollmentForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      labeledField("BFB address", placeholder: "https://your-bfb.example", value: $origin)
      labeledField(
        "Workspace ID", placeholder: "Copy the ID from your workspace", value: $workspaceID)
      labeledField("Mac name", placeholder: "Name shown to your team", value: $deviceLabel)
      HStack {
        Button("Continue in browser") {
          Task {
            await model.enroll(
              origin: origin.trimmingCharacters(in: .whitespacesAndNewlines),
              workspaceID: workspaceID.trimmingCharacters(in: .whitespacesAndNewlines),
              label: deviceLabel)
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          !model.daemonRunning || model.busy || origin.isEmpty || workspaceID.isEmpty
            || deviceLabel.isEmpty)
        if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
      }
    }
  }

  private func labeledField(_ label: String, placeholder: String, value: Binding<String>)
    -> some View
  {
    VStack(alignment: .leading, spacing: 5) {
      Text(label).font(.callout.weight(.medium))
      TextField(placeholder, text: value).textFieldStyle(.roundedBorder).accessibilityLabel(label)
    }
  }
}
