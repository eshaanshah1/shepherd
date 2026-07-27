import AppKit
import Combine

/// Per-pane workbench state: which files are shown, the stitched document they form,
/// and the review comments accumulated against it.
///
/// Owns the stitched `NSTextStorage` directly (rather than a `String` binding) so the
/// editor and this session share one buffer with no copying per keystroke.
@MainActor
final class WorkbenchSession: ObservableObject {
    let paneID: String
    let cwd: String

    @Published var mode: DiffMode = .workingTree
    @Published private(set) var files: [DiffFile] = []
    /// The one file the editor is scoped to, or nil for the whole diff.
    @Published private(set) var focusedFile: String?
    @Published private(set) var baseLabel: String?
    @Published private(set) var isRepo = true
    @Published private(set) var loading = false
    @Published private(set) var stitchMap = StitchMap(excerpts: [])
    @Published private(set) var blockMap = BlockMap()
    @Published var comments: [ReviewComment] = []
    /// Stitched line the editor's cursor sits on, so the chrome can act on "this line"
    /// without reaching into the text view.
    @Published var cursorStitchedLine: Int?
    /// Bumped whenever the stitched document is rebuilt, so views re-read it.
    @Published private(set) var revision = 0

    // MARK: - Staging

    /// Repo-relative paths with staged changes, so the rail can split Staged from
    /// Unstaged. Re-read from the index after every write.
    @Published private(set) var stagedPaths: Set<String> = []
    /// Paths with unstaged working-tree changes (incl. untracked). A listed file in
    /// neither set is already committed — nothing to stage, so it gets no button.
    @Published private(set) var unstagedPaths: Set<String> = []
    /// Stitched rows covered by the editor's text selection — that *is* the staging
    /// selection. Selecting the lines you mean is something you already do, so it costs
    /// no chrome; a per-row checkbox column cost 26pt on every line for the same answer.
    /// Multiple selections (multi-cursor) union, so a non-contiguous pick still works.
    @Published var selectedLines: Set<Int> = []
    /// The commit message being composed, owned here so it survives a rail re-render.
    @Published var commitDraft = ""
    /// The upstream a push would go to, and the branch name; both nil ⇒ detached HEAD.
    @Published private(set) var pushTarget: String?
    @Published private(set) var branchName: String?
    /// True while a git write is in flight, so the buttons can't be double-fired.
    @Published private(set) var writing = false
    /// The last git failure, shown inline. `GitResult` exists so a rejected patch says
    /// why instead of failing silently.
    @Published var lastError: String?

    /// Where each stitched row came from, in document order — parallel to `rowStyles`.
    private(set) var rowOrigins: [RowOrigin] = []

    /// Installed by the editor's coordinator, which owns the only reachable reference to
    /// the live text view. Lets the chrome move the cursor without holding one itself.
    var scrollToStitchedLine: ((Int) -> Void)?

    /// Resolves the editor's scroll view, so the gutter can track scrolling directly
    /// instead of waiting a run-loop pass for `SourceEditorState.scrollPosition`.
    ///
    /// A provider rather than the view itself: coordinators are prepared inside
    /// `TextViewController.init`, and `scrollView` is not built until `loadView()` — so
    /// reading it when the coordinator is installed always yields nil. The gutter calls
    /// this until it resolves.
    var editorScrollViewProvider: (() -> NSScrollView?)?

    /// Asks the gutter to (re)try attaching to the editor's scroll view. Registered by
    /// the gutter, called once the editor's controller has loaded its view.
    ///
    /// A push rather than the gutter retrying on its own: the gutter only redraws once
    /// it is attached, so a retry driven from `draw` deadlocks — no attach, no draw, no
    /// attach.
    var requestGutterAttach: (() -> Void)?

    /// Real geometry for a stitched row, straight from the editor's layout manager, so
    /// the gutter and the text cannot hold different opinions about where a line sits.
    var editorLineMetrics: ((Int) -> (yPos: CGFloat, height: CGFloat)?)?
    /// Row index at a document y.
    var editorLineIndex: ((CGFloat) -> Int?)?

    func requestScroll(toStitchedLine line: Int) { scrollToStitchedLine?(line) }

    /// The first stitched row belonging to a file.
    func firstStitchedLine(ofFile path: String) -> Int? {
        rowOrigins.firstIndex { $0.path == path }
    }

    /// Show one file's diff on its own, or all of them when nil.
    ///
    /// The stitched document is a multibuffer, so "go to a file" could have been a
    /// scroll — but on a 287-file diff scrolling to a file is not the same as reading it,
    /// and every other diff tool narrows. Clicking the focused file again clears the
    /// focus and puts the whole diff back.
    func focus(file path: String?) {
        let next = (path != nil && path == focusedFile) ? nil : path
        guard next != focusedFile else { return }
        focusedFile = next
        rebuild()
    }

    /// The files the stitched document currently covers — the focused one, or all.
    var displayedFiles: [DiffFile] {
        guard let focusedFile else { return files }
        return files.filter { $0.path == focusedFile }
    }

    /// The stitched document. One storage, shared with the editor.
    let storage = NSTextStorage()

    /// Row style per stitched line, precomputed at build time — the render delegate and
    /// the gutter both read this, and it must be a cheap lookup (it runs per fragment).
    private(set) var rowStyles: [RowStyle] = []
    /// Gutter metadata per stitched line, in the same order.
    private(set) var gutterRows: [(old: Int?, new: Int?)] = []

    private var buffers: [SourceID: SourceBuffer] = [:]

    /// Largest line number on each side, cached — `EditorHost` reads them to size the
    /// gutter's two number columns, and scanning 32k rows per body evaluation is not
    /// free. **0 means that side is empty everywhere**, and the column collapses: an
    /// all-additions diff has no old numbers, and reserving a blank column for them left
    /// a wide dead band between the checkbox and the line number.
    private(set) var maxOldLineNumber = 0
    private(set) var maxNewLineNumber = 0

    /// The highlighter and the render delegate live here, not in `EditorHost`, because
    /// they must be the **same objects** across view updates.
    ///
    /// `SourceEditor` compares highlight providers by `ObjectIdentifier`; a fresh
    /// instance per `body` made every scroll tick look like a provider change, so it
    /// re-ran `setHighlightProviders` (dropping every cached parse) and `reloadUI()` on
    /// each frame. That was the whole "scrolling doesn't work and it eats the CPU"
    /// symptom.
    lazy var highlighter: MultiHighlighter = MultiHighlighter(
        anchor: { [weak self] line in self?.sourceAnchor(atStitchedLine: line) },
        textForSource: { [weak self] source, side in self?.text(for: source, side: side) ?? "" },
        rangeForStitchedLine: { [weak self] line in self?.range(forStitchedLine: line) },
        stitchedLineRange: { [weak self] range in self?.stitchedLines(in: range) }
    )

    lazy var renderer: BlockRenderer = BlockRenderer(
        stitchedLineForOffset: { [weak self] offset in self?.stitchedLine(forOffset: offset) },
        styleForStitchedLine: { [weak self] line in self?.style(atStitchedLine: line) ?? .plain }
    )

    init(paneID: String, cwd: String) {
        self.paneID = paneID
        self.cwd = cwd
    }

    /// The buffer for a file, created (and watched) on first use.
    ///
    /// Lazy rather than one-per-changed-file up front: each buffer reads the whole file
    /// and arms a `DispatchSource`, so a 287-file diff would open 287 descriptors and
    /// read every file before drawing a row. The highlighter asks for the files it
    /// actually paints.
    func buffer(for source: SourceID) -> SourceBuffer {
        bufferUseCounter += 1
        if let existing = buffers[source] {
            existing.lastUsed = bufferUseCounter
            return existing
        }
        let buffer = SourceBuffer(source: source, cwd: cwd, baseLabel: baseLabel)
        buffer.lastUsed = bufferUseCounter
        buffer.onExternalWrite = { [weak self] in
            self?.highlighter.invalidate(source: source)
            self?.scheduleReload()
        }
        buffer.startWatching()
        buffers[source] = buffer
        evictBuffersIfNeeded()
        return buffer
    }

    private var bufferUseCounter: UInt64 = 0
    /// Comfortably more than a viewport's worth of files, so eviction never thrashes.
    private static let maxLiveBuffers = 32

    /// Retire the least recently used clean buffers.
    ///
    /// Each one holds a whole file's text, its base blob, and an open file descriptor
    /// with a `DispatchSource` on it. Unbounded, reviewing a 287-file diff ended up
    /// holding all 287 — and 287 descriptors — until the workbench closed. **Dirty
    /// buffers are never evicted**: they carry unsaved edits, which is user state, not
    /// cache.
    private func evictBuffersIfNeeded() {
        while buffers.count > Self.maxLiveBuffers {
            guard let victim = buffers.values
                .filter({ !$0.isDirty })
                .min(by: { $0.lastUsed < $1.lastUsed }) else { return }
            victim.stopWatching()
            buffers.removeValue(forKey: victim.source)
        }
    }

    func text(for source: SourceID) -> String { buffer(for: source).text }

    /// A file's text on one side of the diff: the working copy, or the base blob.
    func text(for source: SourceID, side: DiffSide) -> String {
        let buffer = buffer(for: source)
        return side == .new ? buffer.text : (buffer.baseText ?? "")
    }

    /// The file, side, and **0-based source line** a stitched row shows.
    ///
    /// Not derived from `StitchMap`: an excerpt's `lineRange` holds *stitched* indices
    /// (a hunk interleaves both sides, so it is not a contiguous range in either file),
    /// and reading them as source lines fed the highlighter arbitrary lines of the file —
    /// which is what painted syntax colors on unrelated words. The gutter's per-row
    /// numbers are the real mapping, and they are 1-based.
    func sourceAnchor(atStitchedLine line: Int) -> (source: SourceID, side: DiffSide, line: Int)? {
        guard rowOrigins.indices.contains(line), line < gutterRows.count else { return nil }
        let origin = rowOrigins[line]
        let row = gutterRows[line]
        let source = SourceID((cwd as NSString).appendingPathComponent(origin.path))
        switch origin.kind {
        case .removed:
            return row.old.map { (source, DiffSide.old, $0 - 1) }
        case .added, .context:
            return row.new.map { (source, DiffSide.new, $0 - 1) }
        }
    }

    /// Read the diff off the main thread, then rebuild the stitched document.
    ///
    /// `DiffReader.read` spawns `git`, and running a `Process` during a SwiftUI layout
    /// pass wedges the update cycle — the same discipline the old panel used.
    func load() {
        loading = true
        let mode = self.mode
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.read(cwd: cwd, mode: mode)
            let staged = result.isRepo ? GitStaging.stagedPaths(cwd: cwd) : []
            let unstaged = result.isRepo ? GitStaging.unstagedPaths(cwd: cwd) : []
            let branch = result.isRepo ? GitStaging.currentBranch(cwd: cwd) : nil
            let upstream = result.isRepo ? GitStaging.upstream(cwd: cwd) : nil
            DispatchQueue.main.async {
                self.files = result.files
                // A focused file that fell out of the diff would leave an empty editor
                // with nothing explaining why.
                if let focused = self.focusedFile,
                   !result.files.contains(where: { $0.path == focused }) {
                    self.focusedFile = nil
                }
                self.baseLabel = result.baseLabel
                self.isRepo = result.isRepo
                self.stagedPaths = staged
                self.unstagedPaths = unstaged
                self.branchName = branch
                self.pushTarget = upstream
                self.rebuild()
                self.loading = false
            }
        }
    }

    private var reloadWork: DispatchWorkItem?

    /// Coalesce reloads triggered by disk writes.
    ///
    /// `load()` is a full `git diff` of the whole tree plus a document rebuild, and an
    /// agent saving several files fires one watcher per file — un-coalesced, that is a
    /// reload storm that also throws away the scroll position each time.
    func scheduleReload() {
        reloadWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.load() }
        reloadWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    /// Turn the parsed diff into excerpts, blocks, a stitched string, and the per-line
    /// style/gutter tables.
    private func rebuild() {
        var excerpts: [Excerpt] = []
        var blocks: [Block] = []
        var styles: [RowStyle] = []
        var gutter: [(old: Int?, new: Int?)] = []
        var stitched = ""
        var line = 0

        let rowHeight = WorkbenchMetrics.rowHeight
        var maxOld = 0, maxNew = 0
        let shown = displayedFiles
        for file in shown {
            let source = SourceID((cwd as NSString).appendingPathComponent(file.path))
            blocks.append(Block(id: "hdr-\(file.path)", kind: .fileHeader(source),
                                beforeStitchedLine: line, height: rowHeight + 12))

            guard !file.isBinary else { continue }

            for hunk in file.hunks {
                let start = line
                // Paired once per hunk, not per line: the old per-line lookup rebuilt
                // both side arrays every time, so a 1000-line hunk did a million array
                // appends before drawing anything.
                let pairing = HunkPairing(kinds: hunk.lines.map(\.kind),
                                          texts: hunk.lines.map(\.text))
                for (lineIndex, diffLine) in hunk.lines.enumerated() {
                    stitched += diffLine.text + "\n"
                    styles.append(Self.style(for: diffLine,
                                             counterpart: pairing.counterpart(atLineIndex: lineIndex)))
                    gutter.append((old: diffLine.oldLineNo, new: diffLine.newLineNo))
                    maxOld = max(maxOld, diffLine.oldLineNo ?? 0)
                    maxNew = max(maxNew, diffLine.newLineNo ?? 0)
                    line += 1
                }
                guard line > start else { continue }
                // One excerpt per hunk. The line range is the *stitched* span here
                // because a hunk interleaves both sides; W1 splits old/new per side.
                excerpts.append(Excerpt(id: "\(file.path)#\(hunk.header)", source: source,
                                        lineRange: start..<line, kind: .hunk))
            }
        }

        storage.setAttributedString(NSAttributedString(string: stitched,
                                                       attributes: WorkbenchMetrics.baseAttributes))
        lineStarts = SourceHighlightCache.lineStartOffsets(stitched)
        stitchMap = StitchMap(excerpts: excerpts)
        blockMap = BlockMap(blocks: blocks)
        rowStyles = styles
        gutterRows = gutter
        rowOrigins = StageSelection.rowOrigins(files: shown)
        maxOldLineNumber = maxOld
        maxNewLineNumber = maxNew
        selectedLines.removeAll()   // row indices don't survive a rebuild
        revision += 1
    }

    /// Row tint plus word spans, against the hunk's precomputed pairing.
    private static func style(for line: DiffLine, counterpart: String?) -> RowStyle {
        switch line.kind {
        case .context:
            return .plain
        case .added, .removed:
            guard let counterpart else {
                return RowStyle(tint: line.kind == .added ? .added : .removed, wordSpans: [])
            }
            let (old, new) = line.kind == .added ? (counterpart, line.text) : (line.text, counterpart)
            let spans = WordDiff.spans(old: old, new: new)
            return RowStyle(tint: line.kind == .added ? .added : .removed,
                            wordSpans: line.kind == .added ? spans.new : spans.old)
        }
    }

    /// The gutter's sign column. Derived from the row's kind rather than stored per row —
    /// `Character` is 16 bytes in Swift, which is a lot to carry 32,000 times for `+`.
    static func sign(for kind: DiffLineKind) -> Character? {
        switch kind {
        case .added:   return "+"
        case .removed: return "-"
        case .context: return nil
        }
    }

    // MARK: - Lookups the editor layer calls per fragment (must stay cheap)

    func style(atStitchedLine line: Int) -> RowStyle {
        line >= 0 && line < rowStyles.count ? rowStyles[line] : .plain
    }

    /// Line-start offsets, computed once per rebuild. These lookups run per text
    /// fragment per layout pass, so recomputing them per call would be quadratic.
    private var lineStarts: [Int] = []

    /// Stitched line for a document offset, via binary search over `lineStarts`.
    func stitchedLine(forOffset offset: Int) -> Int? {
        guard let first = lineStarts.first, offset >= first else { return nil }
        var low = 0, high = lineStarts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if lineStarts[mid] <= offset { low = mid } else { high = mid - 1 }
        }
        return low
    }

    /// The stitched document's range for one line, excluding its newline.
    func range(forStitchedLine line: Int) -> NSRange? {
        guard line >= 0, line < lineStarts.count else { return nil }
        let start = lineStarts[line]
        let end = line + 1 < lineStarts.count ? lineStarts[line + 1] - 1 : storage.length
        return NSRange(location: start, length: max(0, end - start))
    }

    func stitchedLines(in range: NSRange) -> Range<Int>? {
        guard let lower = stitchedLine(forOffset: range.location) else { return nil }
        let upper = stitchedLine(forOffset: max(range.location, range.location + range.length - 1)) ?? lower
        return lower..<(upper + 1)
    }

    // MARK: - Staging actions

    /// Select whole stitched rows in the editor — what a gutter click/drag does.
    /// Installed by the editor's coordinator, like `scrollToStitchedLine`.
    var setSelectedRows: ((Range<Int>) -> Void)?

    /// The rows a stage/unstage would act on: the selected ones, else the cursor's hunk.
    /// Falling back to the cursor's hunk is what makes ⌘⏎ useful with no selection at all.
    var effectiveStagingRows: Set<Int> {
        if !selectedLines.isEmpty { return selectedLines }
        guard let cursor = cursorStitchedLine else { return [] }
        return Set(StageSelection.hunkRows(atStitchedLine: cursor, origins: rowOrigins))
    }

    /// Whether stage/unstage would act on anything — O(1), for the chrome to gate on.
    /// Views must not ask `effectiveStagingRows`, which materializes a set on every
    /// SwiftUI body evaluation (i.e. on every cursor move).
    var hasStagingTarget: Bool {
        if !selectedLines.isEmpty { return true }
        guard let cursor = cursorStitchedLine else { return false }
        return rowOrigins.indices.contains(cursor)
    }

    func stageSelection() { applyStaging(lines: effectiveStagingRows, reverse: false) }
    func unstageSelection() { applyStaging(lines: effectiveStagingRows, reverse: true) }

    /// Stage or unstage rows by synthesizing one patch per file and applying it to the
    /// index. Off the main thread — `Process` pumps a run loop, and doing that during a
    /// SwiftUI layout pass wedges the update cycle.
    ///
    /// Known limitation: the displayed diff is `HEAD`-based, so a patch built from it
    /// can be rejected when the file *already* has staged changes (the index no longer
    /// matches the patch's old side). Git says so on stderr and it surfaces in
    /// `lastError` rather than failing silently.
    func applyStaging(lines: Set<Int>, reverse: Bool) {
        // `displayedFiles`, not `files` — the row origins were built from what is on
        // screen, so the hunk indices only line up against the same list.
        let allGroups = StageSelection.selections(forStitchedLines: lines,
                                                  origins: rowOrigins, files: displayedFiles)
        guard !allGroups.isEmpty, !writing else { return }
        // A committed file has nothing in the working tree to move; the patch would be
        // rejected with git's "does not apply", which explains nothing.
        let groups = allGroups.filter {
            unstagedPaths.contains($0.path) || stagedPaths.contains($0.path)
        }
        guard !groups.isEmpty else {
            lastError = allGroups.count == 1
                ? "\(allGroups[0].path) has no uncommitted changes — nothing to stage."
                : "Those lines are already committed — nothing to stage."
            return
        }
        let cwd = self.cwd
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            var failure: String?
            for group in groups {
                guard let patch = PatchSynth.patch(path: group.path, oldPath: group.oldPath,
                                                   hunks: group.hunks,
                                                   selections: group.selections) else { continue }
                if let error = GitStaging.applyToIndex(patch: patch, cwd: cwd,
                                                      reverse: reverse).errorText {
                    failure = error
                    break
                }
            }
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = failure
                self.load()   // clears the selection via rebuild
            }
        }
    }

    /// Whole-file stage/unstage, which handles adds, deletes, and renames without the
    /// special-casing a synthesized patch would need.
    ///
    /// Takes a list and issues **one** git call: `writing` gates concurrent writes, so a
    /// loop of single-file calls had every call after the first silently dropped —
    /// "stage all" staged exactly one file.
    func setStaged(_ staged: Bool, paths: [String]) {
        guard !writing, !paths.isEmpty else { return }
        let cwd = self.cwd
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = staged ? GitStaging.stageFiles(paths, cwd: cwd)
                                : GitStaging.unstageFiles(paths, cwd: cwd)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                self.load()
            }
        }
    }

    func setStaged(_ staged: Bool, path: String) { setStaged(staged, paths: [path]) }

    var canCommit: Bool {
        !writing && !stagedPaths.isEmpty
            && !commitDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Why push is unavailable, or nil when it is. A disabled button with a reason,
    /// never a dead one.
    var pushBlockedReason: String? {
        guard pushTarget == nil else { return nil }
        return branchName == nil ? "Detached HEAD — nothing to push." : nil
    }

    func commit(push: Bool) {
        guard canCommit else { return }
        let message = commitDraft
        let cwd = self.cwd
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            var failure = GitStaging.commit(message: message, cwd: cwd).errorText
            if failure == nil, push { failure = GitStaging.push(cwd: cwd).errorText }
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = failure
                if failure == nil { self.commitDraft = "" }
                self.load()
            }
        }
    }

    // MARK: - Comments

    /// The reviewable anchor a stitched line points at: which file, which line, and
    /// which side of the diff. Added/context lines anchor to the new side, removals to
    /// the old — the same mapping the old panel's `HighlightMap` used.
    func anchor(atStitchedLine line: Int) -> (file: String, line: Int, side: DiffSide)? {
        guard line >= 0, line < gutterRows.count,
              let excerpt = stitchMap.excerpt(atStitchedLine: line) else { return nil }
        let row = gutterRows[line]
        let relative = relativePath(of: excerpt.source)
        if let new = row.new { return (relative, new, .new) }
        if let old = row.old { return (relative, old, .old) }
        return nil
    }

    /// Repo-relative path, which is what `ReviewComment` and the agent prompt expect.
    private func relativePath(of source: SourceID) -> String {
        guard source.path.hasPrefix(cwd) else { return source.path }
        return String(source.path.dropFirst(cwd.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    func addComment(file: String, line: Int, side: DiffSide, text: String) {
        comments.append(ReviewComment(id: UUID(), file: file, line: line, side: side, text: text))
    }

    func removeComment(_ id: ReviewComment.ID) { comments.removeAll { $0.id == id } }

    // MARK: - GitHub review threads

    /// Which thread has its reply composer open, and which resolved threads the user
    /// expanded — per-pane view state, so it belongs here rather than in the view.
    @Published var threadsPanelOpen = false
    @Published var replyingToThread: String?
    @Published var expandedResolvedThreads: Set<String> = []

    func toggleExpandedResolved(_ id: String) {
        if expandedResolvedThreads.contains(id) { expandedResolvedThreads.remove(id) }
        else { expandedResolvedThreads.insert(id) }
    }

    /// Append a GitHub review comment to the outgoing batch so it ships with the same
    /// "Send to agent" button, framed for the agent via `ReviewComment.githubAuthor`.
    func addGitHubComment(file: String, line: Int, side: DiffSide, author: String, body: String) {
        comments.append(ReviewComment(id: UUID(), file: file, line: line, side: side,
                                      text: body, githubAuthor: author))
    }

    /// The stitched row showing `file`'s `line` on `side`, or nil when the current diff
    /// doesn't show it — which is also how a review thread is judged unanchored.
    func stitchedLine(forFile file: String, line: Int, side: DiffSide) -> Int? {
        for (idx, origin) in rowOrigins.enumerated() where origin.path == file {
            guard idx < gutterRows.count else { break }
            let row = gutterRows[idx]
            if side == .new, row.new == line { return idx }
            if side == .old, row.old == line { return idx }
        }
        return nil
    }

    /// Files whose buffer holds unsaved edits, for the rail's dirty markers.
    var dirtySources: Set<SourceID> {
        Set(buffers.values.filter(\.isDirty).map(\.source))
    }

    /// Files an agent rewrote while we held unsaved edits.
    var staleSources: Set<SourceID> {
        Set(buffers.values.filter(\.needsReconciliation).map(\.source))
    }

    func stopWatching() { buffers.values.forEach { $0.stopWatching() } }
}

/// Shared metrics for the workbench's text surface.
enum WorkbenchMetrics {
    static var font: NSFont {
        Theme.monoFontName.flatMap { NSFont(name: $0, size: 13) }
            ?? .monospacedSystemFont(ofSize: 13, weight: .regular)
    }

    /// One stitched line is exactly one row: the workbench never wraps (a diff scrolls
    /// horizontally, like the old panel did), which is what lets the gutter position
    /// rows arithmetically instead of querying layout per row.
    ///
    /// Cached against the resolved font — it is read per file during a rebuild and on
    /// every gutter update, and each miss allocated an `NSLayoutManager`. Invalidated by
    /// a font change, which is the only thing that moves it (⌘⇧R re-resolves the theme).
    static var rowHeight: CGFloat {
        let font = self.font
        if let cached = cachedRowHeight, cachedRowHeightFont == font { return cached }
        let height = NSLayoutManager().defaultLineHeight(for: font) * Theme.lineHeightMultiple
        cachedRowHeight = height
        cachedRowHeightFont = font
        return height
    }

    private static var cachedRowHeight: CGFloat?
    private static var cachedRowHeightFont: NSFont?

    static var baseAttributes: [NSAttributedString.Key: Any] {
        [.font: font, .foregroundColor: NSColor(hex24: Theme.Code.text)]
    }
}
