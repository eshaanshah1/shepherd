import Foundation

/// Distinguishes the throwaway **dev** build from the daily/release app. The two share
/// identical sources and differ only in bundle id (`…​.dev`) and product name
/// ("Shepherd Dev"), so a single runtime switch is enough: dev gets its own UserDefaults
/// domain (for free, keyed by bundle id) and its own `~/.shepherd/dev` support subtree
/// (control socket + worktrees), and never touches the daily instance's state.
///
/// On launch a dev build mirrors the daily app's UI layout (see `AgentStore.devSeedState`).
enum AppMode {
    /// Bundle id of the daily/release app — the domain a dev build reads its seed layout from.
    static let dailyBundleID = "com.shepherd.Shepherd"

    static var isDev: Bool { Bundle.main.bundleIdentifier?.hasSuffix(".dev") ?? false }

    /// Base support dir: `~/.shepherd`, or `~/.shepherd/dev` for a dev build.
    static var supportDir: String {
        let base = (NSHomeDirectory() as NSString).appendingPathComponent(".shepherd")
        return isDev ? (base as NSString).appendingPathComponent("dev") : base
    }

    /// A path under the support dir (creates nothing).
    static func supportPath(_ component: String) -> String {
        (supportDir as NSString).appendingPathComponent(component)
    }
}
