import SwiftUI
import UserNotifications

/// The welcome card's three rows. The plugin row is the load-bearing one: without it no
/// hook fires and no pane ever leaves `shell`.
struct OnboardingWelcomeView: View {
    @EnvironmentObject var onboarding: OnboardingController

    @State private var pluginState = ClaudePluginInstaller.currentState()
    @State private var pluginError: String?
    @State private var notifAuthorized = false
    @State private var theme = "dark"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            row(done: isPluginInstalled, title: "Claude Code plugin",
                subtitle: pluginError ?? pluginSubtitle,
                bad: pluginError != nil) {
                if case .notInstalled = pluginState {
                    Button("Install") { installPlugin() }
                        .font(.ui(11))
                        .focusable(false)
                }
            }

            row(done: notifAuthorized, title: "Notifications",
                subtitle: notifAuthorized
                    ? "allowed — you'll be pulled back when an agent needs you"
                    : "allow it when macOS asks, or enable it in System Settings",
                bad: false) { EmptyView() }

            row(done: true, title: "Theme", subtitle: "matches the terminal grid too",
                bad: false) {
                Picker("", selection: $theme) {
                    Text("Dark").tag("dark")
                    Text("Light").tag("light")
                    Text("Warm").tag("warm")
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(width: 170)
                .focusable(false)
                .onChange(of: theme) { applyTheme($0) }
            }
        }
        .task {
            let s = await UNUserNotificationCenter.current().notificationSettings()
            notifAuthorized = s.authorizationStatus == .authorized
        }
    }

    private func row<Trailing: View>(done: Bool, title: String, subtitle: String,
                                     bad: Bool,
                                     @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Circle()
                .fill(done ? Theme.needsCheck : Theme.textDim.opacity(0.35))
                .frame(width: 6, height: 6)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.ui(12))
                    .foregroundColor(Theme.textPrimary)
                Text(subtitle)
                    .font(.ui(10))
                    .foregroundColor(bad ? Theme.error : Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            trailing()
        }
    }

    private var isPluginInstalled: Bool {
        if case .installed = pluginState { return true }
        return false
    }

    private var pluginSubtitle: String {
        switch pluginState {
        case .installed:              return "installed — agent states will work"
        case .notInstalled:           return "needed for agent states"
        case .unavailable:            return "not bundled in this build"
        case .linkedElsewhere(let p): return "another checkout is linked: \(p)"
        case .occupied:               return "something already sits at ~/.claude/skills/shepherd"
        }
    }

    private func installPlugin() {
        do {
            try ClaudePluginInstaller.install()
            pluginError = nil
        } catch {
            pluginError = error.localizedDescription
        }
        pluginState = ClaudePluginInstaller.currentState()
        onboarding.refreshPreflight()
    }

    private func applyTheme(_ value: String) {
        try? ShepherdConfigWriter.set([ConfigEdit(key: "theme", kind: .shepherd, value: value)])
        onboarding.reloadConfig()
    }
}
