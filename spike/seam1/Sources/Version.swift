import Foundation

/// A tolerant semver: `major.minor.patch` with an optional `-suffix` (any
/// dash-suffixed build, e.g. `-dev`, counts as a prerelease and sorts *below*
/// the same numeric release). Accepts an optional leading `v`.
struct Version: Comparable, Equatable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int
    let isPrerelease: Bool

    init?(_ raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        let pre = s.contains("-")
        let core = s.split(separator: "-", maxSplits: 1).first.map(String.init) ?? s
        let parts = core.split(separator: ".").map { Int($0) }
        guard parts.count >= 1, parts.count <= 3, !parts.contains(nil) else { return nil }
        major = parts[0]!
        minor = parts.count > 1 ? parts[1]! : 0
        patch = parts.count > 2 ? parts[2]! : 0
        isPrerelease = pre
    }

    var description: String { "\(major).\(minor).\(patch)" + (isPrerelease ? "-pre" : "") }

    static func < (a: Version, b: Version) -> Bool {
        if a.major != b.major { return a.major < b.major }
        if a.minor != b.minor { return a.minor < b.minor }
        if a.patch != b.patch { return a.patch < b.patch }
        // same numeric core: a prerelease is older than the final release
        if a.isPrerelease != b.isPrerelease { return a.isPrerelease }
        return false
    }
}

/// The running app's version, read from the bundle. Falls back to a dev
/// sentinel so a mis-stamped build never claims to be a real release.
enum AppVersion {
    static var current: Version {
        let raw = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return raw.flatMap(Version.init) ?? Version("0.0.0-dev")!
    }
}

/// Should an available update be surfaced *automatically*, given the version the
/// user last chose to skip? Anything strictly newer than a skipped version (or
/// nothing skipped) surfaces; the exact skipped version stays hidden.
func shouldSurface(available: Version, skipped: Version?) -> Bool {
    guard let skipped else { return true }
    return available > skipped
}
