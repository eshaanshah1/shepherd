import Foundation

struct UpdateAvailable: Equatable {
    let version: Version
    let tag: String
    let notes: String
    let zipURL: URL
}

/// Checks the public repo's latest GitHub Release and downloads/unpacks its
/// `Shepherd.zip`. Pure parsing (`parseRelease`/`chooseUpdate`) is unit-tested;
/// `checkForUpdate`/`download` are the URLSession/Process shell.
enum UpdateService {
    static let releaseAPI = URL(string: "https://api.github.com/repos/eshaanshah1/shepherd/releases/latest")!
    static let zipAssetName = "Shepherd.zip"

    private struct Release: Decodable {
        let tag_name: String
        let body: String?
        let assets: [Asset]
        struct Asset: Decodable { let name: String; let browser_download_url: String }
    }

    /// Decode the release JSON and locate the `Shepherd.zip` asset. Returns nil
    /// if the JSON is malformed or the zip asset is absent.
    static func parseRelease(_ data: Data) -> (tag: String, notes: String, zipURL: URL)? {
        guard let r = try? JSONDecoder().decode(Release.self, from: data),
              let asset = r.assets.first(where: { $0.name == zipAssetName }),
              let url = URL(string: asset.browser_download_url) else { return nil }
        return (r.tag_name, r.body ?? "", url)
    }

    /// The release as an `UpdateAvailable` iff its version is strictly newer than `current`.
    static func chooseUpdate(current: Version, releaseData: Data) -> UpdateAvailable? {
        guard let parsed = parseRelease(releaseData),
              let v = Version(parsed.tag), v > current else { return nil }
        return UpdateAvailable(version: v, tag: parsed.tag, notes: parsed.notes, zipURL: parsed.zipURL)
    }

    /// Hit the GitHub API and return a newer update, or nil (no update / any failure).
    static func checkForUpdate(current: Version) async -> UpdateAvailable? {
        var req = URLRequest(url: releaseAPI)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Shepherd", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 15
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return chooseUpdate(current: current, releaseData: data)
    }

    enum UpdateError: Error { case download, unpack, verify }

    /// Stream the zip to a temp file (progress 0…1), unpack with `ditto`, and
    /// `codesign --verify` the unpacked bundle. Returns the unpacked .app path.
    static func download(_ update: UpdateAvailable, progress: @escaping (Double) -> Void) async throws -> String {
        // Fresh, unpredictable, 0700 dir — never derived from the (remote) tag,
        // so a hostile tag can neither traverse the filesystem nor race a
        // predictable path.
        let tmp = URL(fileURLWithPath: UpdateInstaller.uniqueTempDir(), isDirectory: true)
        let zipPath = tmp.appendingPathComponent("Shepherd.zip")

        let zip = try await ZipDownload(destination: zipPath, progress: progress).run(update.zipURL)

        // Unpack (ditto preserves the bundle's symlinks/permissions).
        let unpackDir = tmp.appendingPathComponent("unpacked", isDirectory: true)
        try FileManager.default.createDirectory(at: unpackDir, withIntermediateDirectories: true)
        guard run("/usr/bin/ditto", ["-x", "-k", zip.path, unpackDir.path]) == 0 else { throw UpdateError.unpack }
        let appPath = unpackDir.appendingPathComponent("Shepherd.app").path
        guard FileManager.default.fileExists(atPath: appPath) else { throw UpdateError.unpack }

        // Corruption check only (ad-hoc signature; no identity guarantee).
        guard run("/usr/bin/codesign", ["--verify", "--deep", appPath]) == 0 else { throw UpdateError.verify }
        return appPath
    }

    /// Whole-percent granularity: the progress handler hops to the main actor,
    /// so reporting every callback would enqueue one task per received packet.
    static func reportablePercent(written: Int64, total: Int64, last: Int) -> Int? {
        guard total > 0, written >= 0 else { return nil }
        let pct = min(100, Int(Double(written) / Double(total) * 100))
        return pct > last ? pct : nil
    }

    @discardableResult
    private static func run(_ tool: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}

/// One `URLSessionDownloadTask` streamed to `destination` by URLSession itself.
/// Never iterate the response as an `AsyncBytes` sequence for this: it yields one
/// `UInt8` per suspension, and its progress callback then hops to the main actor
/// once per *byte*.
private final class ZipDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let destination: URL
    private let progress: (Double) -> Void
    private var continuation: CheckedContinuation<URL, Error>?
    private var session: URLSession?
    private var lastPercent = -1

    init(destination: URL, progress: @escaping (Double) -> Void) {
        self.destination = destination
        self.progress = progress
    }

    func run(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { c in
            continuation = c
            let s = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            session = s
            s.downloadTask(with: url).resume()
        }
    }

    private func finish(_ result: Result<URL, Error>) {
        guard let c = continuation else { return }
        continuation = nil
        session?.finishTasksAndInvalidate()
        session = nil
        c.resume(with: result)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten written: Int64,
                    totalBytesExpectedToWrite total: Int64) {
        guard let pct = UpdateService.reportablePercent(written: written, total: total, last: lastPercent)
        else { return }
        lastPercent = pct
        progress(Double(pct) / 100)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        // A non-200 still lands here with the error body as the payload.
        guard (downloadTask.response as? HTTPURLResponse)?.statusCode == 200 else {
            finish(.failure(UpdateService.UpdateError.download)); return
        }
        // `location` is removed the moment this returns, so move it synchronously.
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            finish(.success(destination))
        } catch {
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(.failure(error ?? UpdateService.UpdateError.download))
    }
}
