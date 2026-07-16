import SwiftUI
import AppKit
import Highlighter

/// Panel state: current diff, mode, in-progress comments, and the background-staged
/// `pending` result for the GitHub-style "changes available" refresh.
@MainActor
final class DiffReviewModel: ObservableObject {
    @Published var mode: DiffMode = .workingTree
    @Published var files: [DiffFile] = []
    @Published var baseLabel: String? = nil
    @Published var isRepo = true
    @Published var loading = false
    @Published var comments: [ReviewComment] = []
    @Published var staleAvailable = false
    /// The line currently being commented on (its inline composer is open), or nil.
    @Published var composing: Anchor? = nil
    /// Highlighted lines per "path#side", computed off the main thread and published
    /// as they finish. Rows read from this — they NEVER read blobs or highlight in the
    /// view body (doing git/Process work during SwiftUI layout crashes the update cycle).
    @Published var highlights: [String: [NSAttributedString]] = [:]
    /// True while the initial (non-large) files are being highlighted — the panel shows
    /// a loading state rather than flashing uncolored code.
    @Published var highlighting = false
    /// Large diffs the user chose to reveal, and those currently being highlighted.
    @Published var expanded: Set<String> = []
    @Published var expanding: Set<String> = []
    /// Files collapsed via their header. Default (absent) = expanded.
    @Published var collapsedFiles: Set<String> = []
    /// Old/new source per `.md` file path, fetched off the main thread in the same pass
    /// as highlighting (git blobs pump a run loop). `MarkdownDiffView` parses + diffs +
    /// renders it. Rendered by default.
    @Published var mdSources: [String: MarkdownDiffSource] = [:]
    /// `.md` paths the user flipped to the raw unified diff. Default (absent) = rendered.
    @Published var mdRaw: Set<String> = []
    /// Thread id whose inline reply composer is open (GitHub threads), or nil.
    @Published var replyingTo: String? = nil
    /// Resolved thread ids the user expanded (resolved threads collapse by default).
    @Published var expandedResolved: Set<String> = []

    func toggleCollapsed(_ path: String) {
        if collapsedFiles.contains(path) { collapsedFiles.remove(path) } else { collapsedFiles.insert(path) }
    }

    func isMarkdown(_ f: DiffFile) -> Bool {
        let ext = (f.path as NSString).pathExtension.lowercased()
        return (ext == "md" || ext == "markdown") && !f.isBinary
    }

    /// A markdown file shows its rendered block-diff when it isn't flipped to raw and
    /// its blocks have finished computing.
    func showsRendered(_ f: DiffFile) -> Bool {
        isMarkdown(f) && !mdRaw.contains(f.path) && mdSources[f.path] != nil
    }

    func toggleRaw(_ path: String) {
        if mdRaw.contains(path) { mdRaw.remove(path) } else { mdRaw.insert(path) }
    }

    private var pending: DiffReadResult? = nil
    private(set) var cwd: String? = nil
    // Serial so the (single) JavaScriptCore highlighter is never used concurrently.
    private let highlightQueue = DispatchQueue(label: "shepherd.diff.highlight", qos: .userInitiated)
    private var highlightGeneration = 0

    /// Diff lines above which a file is collapsed behind a "Show diff" affordance
    /// (GitHub-style) and skipped by the up-front highlight pass.
    static let largeDiffLineThreshold = 500

    /// Identifies a commentable line: file + line number on a given side.
    struct Anchor: Equatable { let file: String; let line: Int; let side: DiffSide }

    func isLargeDiff(_ f: DiffFile) -> Bool {
        f.hunks.reduce(0) { $0 + $1.lines.count } > Self.largeDiffLineThreshold
    }

    /// Whether a file's rows should render now: small files after highlighting, large
    /// files only once expanded (and done highlighting).
    func isReady(_ f: DiffFile) -> Bool {
        if f.isBinary { return true }
        if isLargeDiff(f) { return expanded.contains(f.path) && !expanding.contains(f.path) }
        return true
    }

    func load(cwd: String?, mode: DiffMode) {
        self.cwd = cwd
        self.mode = mode
        guard let cwd else { files = []; isRepo = false; highlights = [:]; return }
        loading = true
        let m = mode
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.read(cwd: cwd, mode: m)
            DispatchQueue.main.async {
                self.files = result.files
                self.baseLabel = result.baseLabel
                self.isRepo = result.isRepo
                self.loading = false
                self.staleAvailable = false
                self.pending = nil
                self.rehighlight()
            }
        }
    }

    /// Recompute highlights off the main thread for the current files, publishing once
    /// so scroll never hitches. Large + binary files are skipped (large ones highlight
    /// on demand via expandLargeFile). A generation guard drops stale work after reload.
    private func rehighlight() {
        highlights = [:]
        mdSources = [:]
        mdRaw = []                // fresh diff → all markdown rendered
        expanded = []
        expanding = []
        collapsedFiles = []   // fresh diff → all files expanded
        highlightGeneration += 1
        let gen = highlightGeneration
        let targets = files.filter { !$0.isBinary && !isLargeDiff($0) }
        let mdTargets = files.filter { isMarkdown($0) }
        guard let cwd, !(targets.isEmpty && mdTargets.isEmpty) else { highlighting = false; return }
        highlighting = true
        let base = self.baseLabel
        highlightQueue.async {
            var out: [String: [NSAttributedString]] = [:]
            for f in targets {
                if let hl = DiffSyntaxHighlighter.highlightWholeFile(cwd: cwd, path: f.path, side: .new, baseLabel: base) {
                    out["\(f.path)#new"] = hl
                }
                if f.hunks.contains(where: { $0.lines.contains { $0.kind == .removed } }),
                   let hl = DiffSyntaxHighlighter.highlightWholeFile(cwd: cwd, path: f.path, side: .old, baseLabel: base) {
                    out["\(f.path)#old"] = hl
                }
            }
            var sources: [String: MarkdownDiffSource] = [:]
            for f in mdTargets {
                let oldSrc = DiffReader.fileBlob(cwd: cwd, path: f.oldPath ?? f.path, side: .old, baseLabel: base) ?? ""
                let newSrc = DiffReader.fileBlob(cwd: cwd, path: f.path, side: .new, baseLabel: base) ?? ""
                sources[f.path] = MarkdownDiffSource(old: oldSrc, new: newSrc)
            }
            let finalHL = out
            let finalMD = sources
            DispatchQueue.main.async {
                guard gen == self.highlightGeneration else { return }   // superseded by a reload
                self.highlights = finalHL
                self.mdSources = finalMD
                self.highlighting = false
            }
        }
    }

    /// Reveal + highlight one large file on demand (GitHub "Show diff"). Highlights just
    /// that file off the main thread; its rows appear once done.
    func expandLargeFile(_ path: String) {
        guard let cwd, let f = files.first(where: { $0.path == path }) else { return }
        expanded.insert(path)
        guard !f.isBinary else { return }
        expanding.insert(path)
        let base = self.baseLabel
        let gen = highlightGeneration
        highlightQueue.async {
            var out: [String: [NSAttributedString]] = [:]
            if let hl = DiffSyntaxHighlighter.highlightWholeFile(cwd: cwd, path: path, side: .new, baseLabel: base) {
                out["\(path)#new"] = hl
            }
            if f.hunks.contains(where: { $0.lines.contains { $0.kind == .removed } }),
               let hl = DiffSyntaxHighlighter.highlightWholeFile(cwd: cwd, path: path, side: .old, baseLabel: base) {
                out["\(path)#old"] = hl
            }
            let produced = out
            DispatchQueue.main.async {
                guard gen == self.highlightGeneration else { return }
                for (k, v) in produced { self.highlights[k] = v }
                self.expanding.remove(path)
            }
        }
    }

    /// A turn ended while the panel is open: rebuild in the background, keep showing
    /// the current diff, and light the refresh banner.
    func onTurnEnded() {
        guard let cwd else { return }
        let m = mode
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.read(cwd: cwd, mode: m)
            DispatchQueue.main.async { self.pending = result; self.staleAvailable = true }
        }
    }

    /// Swap the pre-built pending diff in (instant); or synchronously reload if none.
    func applyRefresh() {
        if let p = pending {
            files = p.files; baseLabel = p.baseLabel; isRepo = p.isRepo
            pending = nil; staleAvailable = false
            rehighlight()
        } else {
            load(cwd: cwd, mode: mode)
        }
    }

    func beginComment(_ anchor: Anchor) { composing = anchor }
    func cancelComposing() { composing = nil }

    func addComment(_ anchor: Anchor, text: String) {
        comments.append(ReviewComment(id: UUID(), file: anchor.file, line: anchor.line,
                                      side: anchor.side, text: text))
        composing = nil
    }

    func removeComment(_ id: ReviewComment.ID) {
        comments.removeAll { $0.id == id }
    }

    /// Append a GitHub review comment to the outgoing batch so it ships with the same
    /// "Send to agent" button, framed for the agent via `ReviewComment.githubAuthor`.
    func addGitHubComment(file: String, line: Int, side: DiffSide, author: String, body: String) {
        comments.append(ReviewComment(id: UUID(), file: file, line: line, side: side,
                                      text: body, githubAuthor: author))
    }

    func toggleExpandedResolved(_ id: String) {
        if expandedResolved.contains(id) { expandedResolved.remove(id) } else { expandedResolved.insert(id) }
    }

    /// Post a reply via the store (needs the pane id — the panel is pane-scoped).
    func replyToThread(id: String, body: String, forPane paneID: String) {
        AgentStore.shared.replyToThread(id: id, body: body, forPane: paneID)
    }
}

/// Whole-file syntax highlighting (HighlighterSwift / Highlight.js). atom-one-dark
/// tokenizes (a distinct hue per category); each token color is then remapped to the
/// matching role in Shepherd's own `Theme.Code` palette — so the diff and the editor
/// render from the same colors, in the app's voice rather than the library's. Highlight
/// each file once, cache per line, map onto diff lines by line number. Large / minified
/// files skip highlighting and fall back to plain diff coloring.
enum DiffSyntaxHighlighter {
    private static let maxBytes = 500_000
    private static let highlighter: Highlighter? = {
        let h = Highlighter()
        // Match the terminal grid's font so highlighted code and the terminal agree.
        if let name = Theme.monoFontName {
            _ = h?.setTheme("atom-one-dark", withFont: name, ofSize: 13)
        } else {
            _ = h?.setTheme("atom-one-dark")
        }
        return h
    }()

    /// atom-one-dark's token colors paired with their Shepherd `Theme.Code` target.
    /// Each highlighted token is recolored to the target of its nearest anchor — a
    /// semantic remap (keyword→blue, string→green, …), not a nearest-hue match, so
    /// categories that collapse to shared grays in the restrained palette still route
    /// correctly.
    private struct RemapEntry { let r, g, b: CGFloat; let color: NSColor }
    private static func entry(anchor: UInt32, target: UInt32) -> RemapEntry {
        let r = CGFloat((anchor >> 16) & 0xFF) / 255
        let g = CGFloat((anchor >> 8) & 0xFF) / 255
        let b = CGFloat(anchor & 0xFF) / 255
        let color = NSColor(srgbRed: CGFloat((target >> 16) & 0xFF) / 255,
                            green: CGFloat((target >> 8) & 0xFF) / 255,
                            blue: CGFloat(target & 0xFF) / 255, alpha: 1)
        return RemapEntry(r: r, g: g, b: b, color: color)
    }
    private static let remap: [RemapEntry] = [
        entry(anchor: 0xABB2BF, target: Theme.Code.text),      // default text / punctuation
        entry(anchor: 0x5C6370, target: Theme.Code.comment),   // comment
        entry(anchor: 0xC678DD, target: Theme.Code.keyword),   // keyword / control
        entry(anchor: 0x98C379, target: Theme.Code.string),    // string
        entry(anchor: 0xE5C07B, target: Theme.Code.type),      // type / class
        entry(anchor: 0xD19A66, target: Theme.Code.number),    // number / constant
        entry(anchor: 0x61AFEF, target: Theme.Code.function),  // function / title
        entry(anchor: 0xE06C75, target: Theme.Code.variable),  // variable / property / tag
        entry(anchor: 0x56B6C2, target: Theme.Code.builtin),   // built-in / literal
    ]

    /// Read + highlight + split one whole file, or nil if unavailable / too large.
    /// MUST be called off the main thread — it spawns `git show` (which pumps a run
    /// loop) and drives JavaScriptCore; doing either during SwiftUI layout crashes.
    static func highlightWholeFile(cwd: String, path: String, side: DiffSide, baseLabel: String?)
        -> [NSAttributedString]? {
        guard let blob = DiffReader.fileBlob(cwd: cwd, path: path, side: side, baseLabel: baseLabel),
              blob.utf8.count <= maxBytes,
              let raw = highlighter?.highlight(blob, as: language(forPath: path)) else { return nil }
        let attr = applyShepherdPalette(raw)
        var result: [NSAttributedString] = []
        let plain = attr.string as NSString
        plain.enumerateSubstrings(in: NSRange(location: 0, length: plain.length),
                                  options: [.byLines, .substringNotRequired]) { _, range, _, _ in
            result.append(attr.attributedSubstring(from: range))
        }
        return result
    }

    /// Recolor every token to its Shepherd `Theme.Code` role (via the nearest atom-one-dark
    /// anchor) and drop the theme's backgrounds so the diff row tint shows through.
    private static func applyShepherdPalette(_ ns: NSAttributedString) -> NSAttributedString {
        let m = NSMutableAttributedString(attributedString: ns)
        let full = NSRange(location: 0, length: m.length)
        m.removeAttribute(.backgroundColor, range: full)
        m.enumerateAttribute(.foregroundColor, in: full) { value, range, _ in
            guard let col = (value as? NSColor)?.usingColorSpace(.sRGB) else { return }
            let r = col.redComponent, g = col.greenComponent, b = col.blueComponent
            var best = remap[0].color, bestD = CGFloat.greatestFiniteMagnitude
            for e in remap {
                let dr = e.r - r, dg = e.g - g, db = e.b - b
                let d = dr * dr + dg * dg + db * db
                if d < bestD { bestD = d; best = e.color }
            }
            m.addAttribute(.foregroundColor, value: best, range: range)
        }
        return m
    }

    /// Highlight.js language name from a file extension, or nil (auto-detect).
    private static func language(forPath path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "swift": return "swift"
        case "rb": return "ruby"
        case "kt", "kts": return "kotlin"
        case "ts", "tsx": return "typescript"
        case "js", "jsx": return "javascript"
        case "py": return "python"
        case "go": return "go"
        case "java": return "java"
        case "json": return "json"
        case "yml", "yaml": return "yaml"
        case "sh", "bash": return "bash"
        case "md": return "markdown"
        default: return nil
        }
    }
}

struct DiffPanelView: View {
    @EnvironmentObject var store: AgentStore
    @StateObject private var model = DiffReviewModel()

    var body: some View {
        VStack(spacing: 0) {
            header
            if model.staleAvailable { refreshBanner }
            Divider().overlay(Theme.hairline)
            content
        }
        .background(Theme.ground)
        .onAppear { reload() }
        .onChange(of: store.diffPanelPaneID) { _ in reload() }
        .onChange(of: model.mode) { _ in reload() }
        .onChange(of: store.diffTurnTick) { _ in
            if store.diffTurnPane == store.diffPanelPaneID { model.onTurnEnded() }
        }
    }

    private func reload() {
        guard let pid = store.diffPanelPaneID else { return }
        model.load(cwd: store.cwd(forPane: pid), mode: model.mode)
    }

    /// The pane's cached review threads, but only in vs-base mode (they anchor to the PR diff).
    private var paneThreads: [GHReviewThread] {
        guard model.mode == .branchVsBase, let pid = store.diffPanelPaneID else { return [] }
        return store.reviewThreads[pid] ?? []
    }
    private func threadsForFile(_ path: String) -> [GHReviewThread] {
        paneThreads.filter { $0.path == path }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Review").font(.ui(12, .semibold)).foregroundStyle(Theme.textPrimary)
            modeToggle
            Spacer()
            if !model.comments.isEmpty { sendButton }
            GhostIconButton(systemName: "arrow.clockwise", help: "Refresh") { model.applyRefresh() }
            GhostIconButton(systemName: "xmark", help: "Close (⌘G)") { store.diffPanelOpen = false }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    // Flat segmented toggle in Shepherd's idiom — a recessed track with an
    // accent-tinted active segment, not the loud system segmented control.
    private var modeToggle: some View {
        HStack(spacing: 2) {
            segment("Working tree", active: model.mode == .workingTree) { model.mode = .workingTree }
            segment("vs \(model.baseLabel ?? "base")", active: model.mode == .branchVsBase) { model.mode = .branchVsBase }
        }
        .padding(2)
        .background(Theme.raised)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.hairline, lineWidth: 1))
    }

    private func segment(_ title: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.ui(11, active ? .semibold : .medium))
                .foregroundStyle(active ? Theme.working : Theme.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 3)
                .background(active ? Theme.working.opacity(0.16) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
    }

    private var sendButton: some View {
        Button {
            if let pid = store.diffPanelPaneID {
                store.submitReview(model.comments, toPane: pid)
                model.comments.removeAll()
                store.diffPanelOpen = false
            }
        } label: {
            Text("Send to agent \(model.comments.count)")
                .font(.ui(11, .semibold)).foregroundStyle(Theme.working)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Theme.working.opacity(0.16))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
    }


    private var refreshBanner: some View {
        Button { model.applyRefresh() } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .semibold))
                Text("Changes available — refresh").font(.ui(11, .medium))
            }
            .foregroundStyle(Theme.working)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6).background(Theme.working.opacity(0.14))
        }
        .buttonStyle(.plain).focusable(false)
    }

    @ViewBuilder private var content: some View {
        if !model.isRepo {
            centered("Not a git repository")
        } else if model.files.isEmpty {
            centered(model.loading ? "Loading…" : "No changes")
        } else if model.loading || model.highlighting {
            loadingState("Preparing diff…")
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.files, id: \.path) { file in
                        DiffFileView(file: file, model: model,
                                     hasAgent: store.diffPanelPaneID.map { store.hasLiveAgent(paneID: $0) } ?? false,
                                     threads: threadsForFile(file.path))
                    }
                }
                .padding(12)
            }
        }
    }

    private func centered(_ s: String) -> some View {
        VStack { Spacer(); Text(s).foregroundColor(Theme.textDim).font(.system(size: 12)); Spacer() }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadingState(_ s: String) -> some View {
        VStack(spacing: 10) {
            Spacer()
            ProgressView().controlSize(.small)
            Text(s).foregroundStyle(Theme.textDim).font(.ui(12))
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct DiffFileView: View {
    let file: DiffFile
    @ObservedObject var model: DiffReviewModel
    let hasAgent: Bool
    let threads: [GHReviewThread]
    @State private var copied = false
    @State private var showUnanchored = false

    private var collapsed: Bool { model.collapsedFiles.contains(file.path) }

    /// Set of "side#line" keys for every diff line actually shown in this file.
    private var anchoredKeys: Set<String> {
        var keys: Set<String> = []
        for hunk in file.hunks {
            for line in hunk.lines {
                if let a = HighlightMap.sourceLine(for: line) { keys.insert("\(a.side)#\(a.lineNo)") }
            }
        }
        return keys
    }
    /// Threads that DO map to a visible line (rendered inline under their row).
    private var anchoredThreads: [GHReviewThread] {
        threads.filter { t in
            guard let line = t.line else { return false }
            return anchoredKeys.contains("\(t.side)#\(line)")
        }
    }
    /// Threads whose line no longer maps to a shown diff line (outdated / nil line).
    private var unanchoredThreads: [GHReviewThread] {
        threads.filter { t in
            guard let line = t.line else { return true }
            return !anchoredKeys.contains("\(t.side)#\(line)")
        }
    }

    /// Always-visible "copy path" affordance next to the file name (GitHub-style); flips
    /// to a check for ~1s after copying. Copies the repo-relative path shown in the header.
    @ViewBuilder private var copyPathButton: some View {
        Button {
            let pb = NSPasteboard.general
            pb.clearContents(); pb.setString(file.path, forType: .string)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
        } label: {
            TablerIcon(paths: copied ? Tabler.check : Tabler.copy, size: 12)
                .foregroundColor(copied ? Theme.needsCheck : Theme.textDim)
                .padding(3).contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
        .help("Copy path")
    }

    /// Hover-revealed "edit in place" affordance: opens the file in the code
    /// surface's edit mode (jump from reviewing a diff to editing the file).
    @ViewBuilder private var editFileButton: some View {
        if file.status != .deleted, let cwd = model.cwd {
            Button {
                AgentStore.shared.openFile((cwd as NSString).appendingPathComponent(file.path))
            } label: {
                TablerIcon(paths: Tabler.pencil, size: 12)
                    .foregroundColor(Theme.textDim)
                    .padding(3).contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help("Edit this file")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button { model.toggleCollapsed(file.path) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold)).foregroundColor(Theme.textDim)
                            .frame(width: 10)
                        Text(statusGlyph).font(.system(size: 11, weight: .bold)).foregroundColor(statusColor)
                        Text(file.path).font(.system(size: 12, weight: .medium)).foregroundColor(Theme.textPrimary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                HStack(spacing: 2) { copyPathButton; editFileButton }
                Spacer()
                if model.isMarkdown(file) { renderRawToggle }
                Text("+\(file.addedCount)").foregroundColor(Theme.needsCheck).font(.system(size: 11))
                Text("−\(file.removedCount)").foregroundColor(Theme.error).font(.system(size: 11))
            }
            .padding(.bottom, 4)

            if !collapsed && !unanchoredThreads.isEmpty {
                DisclosureGroup(isExpanded: $showUnanchored) {
                    ForEach(unanchoredThreads) { thread in
                        GitHubThreadView(thread: thread, file: file.path, model: model)
                            .padding(.vertical, 4)
                    }
                } label: {
                    Text("\(unanchoredThreads.count) review comment\(unanchoredThreads.count == 1 ? "" : "s") not on the current diff")
                        .font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary)
                }
                .padding(.bottom, 6)
            }

            if collapsed {
                EmptyView()
            } else if model.showsRendered(file), let src = model.mdSources[file.path] {
                MarkdownDiffView(source: src)
                    .padding(.top, 2)
            } else if file.isBinary {
                Text("Binary file").foregroundColor(Theme.textDim).font(.system(size: 11))
            } else if model.isLargeDiff(file) && !model.expanded.contains(file.path) {
                largeDiffPlaceholder
            } else if model.expanding.contains(file.path) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Highlighting…").font(.ui(11)).foregroundStyle(Theme.textDim)
                }.padding(.vertical, 10)
            } else {
                ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        DiffLineRow(line: line, file: file, model: model, hasAgent: hasAgent,
                                    threads: anchoredThreads)
                    }
                }
            }
        }
    }

    /// Rendered-markdown ⇄ raw-diff toggle, shown only on `.md` files. Rendered is the
    /// default; Raw drops to the unified +/- diff (and re-enables line commenting).
    private var renderRawToggle: some View {
        let raw = model.mdRaw.contains(file.path)
        return HStack(spacing: 1) {
            miniSeg("Rendered", active: !raw) { model.mdRaw.remove(file.path) }
            miniSeg("Raw", active: raw) { model.mdRaw.insert(file.path) }
        }
        .padding(1)
        .background(Theme.raised)
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.hairline, lineWidth: 1))
    }

    private func miniSeg(_ title: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.ui(10, active ? .semibold : .medium))
                .foregroundStyle(active ? Theme.working : Theme.textSecondary)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(active ? Theme.working.opacity(0.16) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
    }

    private var lineCount: Int { file.hunks.reduce(0) { $0 + $1.lines.count } }

    private var largeDiffPlaceholder: some View {
        HStack(spacing: 10) {
            Text("Large diff hidden · \(lineCount) lines")
                .font(.ui(12)).foregroundStyle(Theme.textSecondary)
            Spacer()
            Button { model.expandLargeFile(file.path) } label: {
                Text("Show diff").font(.ui(11, .semibold)).foregroundStyle(Theme.textPrimary)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Theme.surface3)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .shepherdCard()
    }

    private var statusGlyph: String {
        switch file.status { case .added: return "A"; case .modified: return "M"
        case .deleted: return "D"; case .renamed: return "R" }
    }
    private var statusColor: Color {
        switch file.status { case .added: return Theme.needsCheck; case .deleted: return Theme.error
        default: return Theme.textDim }
    }
}

/// Diff row rhythm, matched to the editor. CodeEditSourceEditor lays lines out at
/// `lineHeightMultiple` 1.2× the font's natural line height; the diff's SwiftUI rows
/// are tight (~1.0), so we add half the difference as vertical padding above/below
/// each line to land on the same rhythm.
private enum DiffMetrics {
    static let lineHeightMultiple: CGFloat = 1.2
    static let rowPad: CGFloat = {
        let f = Theme.monoFontName.flatMap { NSFont(name: $0, size: 13) }
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let natural = NSLayoutManager().defaultLineHeight(for: f)
        return natural * (lineHeightMultiple - 1) / 2
    }()
}

private struct DiffLineRow: View {
    let line: DiffLine
    let file: DiffFile
    @ObservedObject var model: DiffReviewModel
    let hasAgent: Bool
    let threads: [GHReviewThread]
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Text(gutter).frame(width: 44, alignment: .trailing)
                    .foregroundColor(Theme.textDim).font(.mono(12))
                highlightedText
                    .font(.mono(13))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, DiffMetrics.rowPad)
            .background(bg)
            .overlay(alignment: .leading) {
                // Hover affordance to comment (double-click also works). Only shown when
                // the reviewed pane has a live agent — its absence signals the gate.
                if hovering, hasAgent, anchor != nil {
                    Button { if let a = anchor { model.beginComment(a) } } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.accent)
                            .background(Circle().fill(Theme.ground))
                    }
                    .buttonStyle(.plain).focusable(false).offset(x: 4)
                    .help("Comment on this line")
                }
            }
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture(count: 2) { if hasAgent, let a = anchor { model.beginComment(a) } }

            // Inline comment thread + composer, GitHub-style, under the line.
            ForEach(commentsHere) { c in
                CommentBubble(comment: c) { model.removeComment(c.id) }
                    .padding(.leading, 52).padding(.vertical, 4)
            }
            ForEach(threadsHere) { thread in
                GitHubThreadView(thread: thread, file: file.path, model: model)
                    .padding(.leading, 52).padding(.vertical, 4)
            }
            if let a = anchor, model.composing == a {
                CommentComposer(anchor: a, model: model)
                    .padding(.leading, 52).padding(.vertical, 4)
            }
        }
    }

    private var anchor: DiffReviewModel.Anchor? {
        HighlightMap.sourceLine(for: line).map {
            DiffReviewModel.Anchor(file: file.path, line: $0.lineNo, side: $0.side)
        }
    }
    private var commentsHere: [ReviewComment] {
        guard let a = anchor else { return [] }
        return model.comments.filter { $0.file == a.file && $0.line == a.line && $0.side == a.side }
    }
    private var threadsHere: [GHReviewThread] {
        guard let a = anchor else { return [] }
        return threads.filter { $0.line == a.line && $0.side == a.side }
    }

    @ViewBuilder private var highlightedText: some View {
        if let attr = highlightedLine {
            Text(AttributedString(attr))
        } else {
            Text(sign + line.text).foregroundColor(fg)
        }
    }

    /// The syntax-highlighted attributed line, prefixed with the diff sign, or nil to
    /// fall back to plain coloring. A pure read of the model's pre-computed highlights
    /// — no git/highlight work in the view body (that crashes SwiftUI's layout pass).
    private var highlightedLine: NSAttributedString? {
        guard let anchor = HighlightMap.sourceLine(for: line),
              let lines = model.highlights["\(file.path)#\(anchor.side)"],
              anchor.lineNo - 1 >= 0, anchor.lineNo - 1 < lines.count else { return nil }
        let m = NSMutableAttributedString(string: sign)
        m.append(lines[anchor.lineNo - 1])
        return m
    }

    private var sign: String {
        switch line.kind { case .added: return "+"; case .removed: return "-"; case .context: return " " }
    }
    private var gutter: String {
        "\(line.oldLineNo.map(String.init) ?? " ") \(line.newLineNo.map(String.init) ?? " ")"
    }
    private var fg: Color {
        switch line.kind { case .added: return Theme.needsCheck; case .removed: return Theme.error
        case .context: return Theme.textSecondary }
    }
    private var bg: Color {
        switch line.kind {
        case .added: return Theme.needsCheck.opacity(0.10)
        case .removed: return Theme.error.opacity(0.10)
        case .context: return .clear
        }
    }
}

/// GitHub side letter: new side = "R" (right), old side = "L" (left).
private func sideLetter(_ side: DiffSide) -> String { side == .new ? "R" : "L" }

/// Inline comment composer, shown under the line being commented on. Borrows
/// GitHub's inline-comment *pattern*, styled in Shepherd's idiom: a quiet card,
/// no avatar/ring/markdown chrome. The field grows with the text to a cap, then
/// scrolls. Focus needs no adornment here — nothing competes; the cursor is enough.
private struct CommentComposer: View {
    let anchor: DiffReviewModel.Anchor
    @ObservedObject var model: DiffReviewModel
    @State private var text = ""
    @State private var editorHeight: CGFloat = minEditorHeight
    @FocusState private var focused: Bool

    private static let minEditorHeight: CGFloat = 22
    private static let maxEditorHeight: CGFloat = 132

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Comment on").font(.ui(13, .semibold)).foregroundStyle(Theme.textPrimary)
                Text("\(sideLetter(anchor.side))\(anchor.line)")
                    .font(.mono(13, .medium)).foregroundStyle(Theme.textSecondary)
                Spacer()
            }

            ZStack(alignment: .topLeading) {
                // Invisible measurer: same font + width drives the editor height.
                Text(text.isEmpty ? " " : text)
                    .font(.ui(12)).foregroundColor(.clear)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(GeometryReader { g in
                        Color.clear.preference(key: EditorHeightKey.self, value: g.size.height)
                    })
                TextEditor(text: $text)
                    .font(.ui(12))
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .frame(height: editorHeight)
                if empty {
                    Text("Leave a note for the agent…")
                        .font(.ui(12)).foregroundStyle(Theme.textDim)
                        .padding(.leading, 5).allowsHitTesting(false)
                }
            }
            .onPreferenceChange(EditorHeightKey.self) {
                editorHeight = min(Self.maxEditorHeight, max(Self.minEditorHeight, $0 + 7))
            }

            HStack(spacing: 6) {
                Spacer()
                Button { model.cancelComposing() } label: {
                    Text("Cancel").font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 3).contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                Button {
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { model.addComment(anchor, text: t) }
                } label: {
                    Text("Comment").font(.ui(11, .semibold))
                        .foregroundStyle(empty ? Theme.textDim : Theme.textPrimary)
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(empty ? Color.clear : Theme.surface3)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(empty).focusable(false)
            }
        }
        .padding(10)
        .frame(maxWidth: 440, alignment: .leading)
        .shepherdCard()
        .onAppear { focused = true }
    }
}

private struct EditorHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// A submitted (pending) review comment, shown inline under its line.
private struct CommentBubble: View {
    let comment: ReviewComment
    let onRemove: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(sideLetter(comment.side))\(comment.line)")
                .font(.mono(10, .medium)).foregroundStyle(Theme.textDim)
                .padding(.top, 1)
            Text(comment.text).font(.ui(12)).foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hovering {
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.textDim)
                }.buttonStyle(.plain).focusable(false)
            }
        }
        .padding(9)
        .frame(maxWidth: 440, alignment: .leading)
        .shepherdCard()
        .onHover { hovering = $0 }
    }
}

/// A GitHub PR review thread, rendered in Shepherd's idiom but unmistakably GitHub:
/// a violet left rail + octocat glyph, author/time header, stacked replies, and a
/// footer of Reply / Resolve / Send-to-agent. Resolved threads dim and collapse to
/// their root comment until expanded.
private struct GitHubThreadView: View {
    let thread: GHReviewThread
    let file: String
    @ObservedObject var model: DiffReviewModel
    @EnvironmentObject var store: AgentStore

    private var expanded: Bool { !thread.isResolved || model.expandedResolved.contains(thread.id) }
    private var visibleComments: [GHReviewComment] {
        expanded ? thread.comments : Array(thread.comments.prefix(1))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(Theme.prMerged.opacity(0.6)).frame(width: 3)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    TablerIcon(paths: Tabler.brandGithub, size: 13).foregroundStyle(Theme.prMerged)
                    Text("Review thread").font(.ui(11, .semibold)).foregroundStyle(Theme.prMerged)
                    if thread.isResolved {
                        Text("Resolved").font(.ui(10, .medium)).foregroundStyle(Theme.textDim)
                    }
                    Spacer()
                    if thread.isResolved {
                        Button { model.toggleExpandedResolved(thread.id) } label: {
                            Text(expanded ? "Hide" : "Show").font(.ui(10, .medium)).foregroundStyle(Theme.textDim)
                        }.buttonStyle(.plain).focusable(false)
                    }
                }
                ForEach(visibleComments) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("@\(c.author.isEmpty ? "unknown" : c.author)")
                                .font(.ui(11, .semibold)).foregroundStyle(Theme.textPrimary)
                            Text(Self.relative(c.createdAt)).font(.ui(10)).foregroundStyle(Theme.textDim)
                        }
                        Text(c.body).font(.ui(12)).foregroundStyle(Theme.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if model.replyingTo == thread.id {
                    ThreadReplyComposer(thread: thread, paneID: store.diffPanelPaneID, model: model)
                } else {
                    footer
                }
            }
            .opacity(thread.isResolved && !expanded ? 0.55 : 1)
        }
        .padding(10)
        .frame(maxWidth: 460, alignment: .leading)
        .shepherdCard()
    }

    private var footer: some View {
        HStack(spacing: 14) {
            actionButton("Reply") { model.replyingTo = thread.id }
            actionButton(thread.isResolved ? "Reopen" : "Resolve") {
                if let pid = store.diffPanelPaneID {
                    store.setThreadResolved(id: thread.id, !thread.isResolved, forPane: pid)
                }
            }
            actionButton("Send to agent") {
                if let root = thread.comments.first {
                    model.addGitHubComment(file: file, line: thread.line ?? 0, side: thread.side,
                                           author: root.author, body: root.body)
                }
            }
            Spacer()
        }
    }

    private func actionButton(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.ui(11, .semibold)).foregroundStyle(Theme.prMerged)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).focusable(false)
    }

    /// Compact relative time from an ISO8601 timestamp; falls back to the raw string.
    static func relative(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: iso) else { return iso }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: Date())
    }
}

/// Inline reply composer for a GitHub thread — mirrors `CommentComposer`'s look, posts
/// via the store, and closes on send/cancel.
private struct ThreadReplyComposer: View {
    let thread: GHReviewThread
    let paneID: String?
    @ObservedObject var model: DiffReviewModel
    @State private var text = ""
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $text)
                .font(.ui(12)).scrollContentBackground(.hidden).focused($focused)
                .frame(height: 56)
                .overlay(alignment: .topLeading) {
                    if empty {
                        Text("Reply on GitHub…").font(.ui(12)).foregroundStyle(Theme.textDim)
                            .padding(.leading, 5).padding(.top, 1).allowsHitTesting(false)
                    }
                }
            HStack(spacing: 6) {
                Spacer()
                Button { model.replyingTo = nil } label: {
                    Text("Cancel").font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 3).contentShape(Rectangle())
                }.buttonStyle(.plain).focusable(false)
                Button {
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty, let pid = paneID {
                        model.replyToThread(id: thread.id, body: t, forPane: pid)
                    }
                    model.replyingTo = nil
                } label: {
                    Text("Reply").font(.ui(11, .semibold))
                        .foregroundStyle(empty ? Theme.textDim : Theme.textPrimary)
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(empty ? Color.clear : Theme.surface3)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(empty).focusable(false)
            }
        }
        .onAppear { focused = true }
    }
}
