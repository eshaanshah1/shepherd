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
    /// What the rail is scoped to. A superset of `mode`: `threads` is vs-base narrowed to
    /// the files carrying review threads, so "what have I still to address?" is one click.
    @Published private(set) var scope: WorkbenchScope = .workingTree

    func setScope(_ next: WorkbenchScope) {
        let previous = scope
        guard next != previous else { return }
        scope = next
        if next == .threads { threadsPanelOpen = true }
        if next == .files {
            // Re-reads the unmerged index: this scope carries the conflicts too, and they
            // are the one thing that can have changed under us since the last look.
            loadConflicts()
            return
        }
        guard let nextMode = next.mode else { return }
        // Only reload when the underlying git comparison actually changes; switching
        // between vs-base and threads is a filter over the same diff. Leaving the Files
        // scope always reloads, though — the document on screen is a merge preview and some
        // hand-opened files, so an unchanged `mode` would leave it there.
        if mode != nextMode {
            mode = nextMode
        } else if previous == .files {
            load()
        }
    }
    @Published private(set) var files: [DiffFile] = []
    /// Working-tree mode's staged half. Its rows sit below a STAGED divider and their
    /// patches are built from this diff, never the unstaged one.
    @Published private(set) var stagedFiles: [DiffFile] = []
    /// The one file the editor is scoped to, or nil for the whole diff.
    @Published private(set) var focusedFile: String?
    /// Per file, the 0-based new-side lines revealed out of the gaps between hunks.
    @Published private(set) var revealedLines: [String: Set<Int>] = [:]

    /// Reveal a slice of a collapsed gap. Ten lines at a time from whichever end was
    /// clicked, or the whole thing when it is short enough that two directions is silly.
    func reveal(_ collapsed: Range<Int>, inFile path: String, fromTop: Bool) {
        let slice = HunkGaps.isFullyExpandable(collapsed)
            ? Set(collapsed)
            : (fromTop ? HunkGaps.expandingDown(collapsed) : HunkGaps.expandingUp(collapsed))
        revealedLines[path, default: []].formUnion(slice)
        rebuild()
    }
    @Published private(set) var baseLabel: String?
    /// The base branch's name whatever the mode, so the scope pill's label never changes
    /// out from under the pointer.
    @Published private(set) var baseName: String?
    @Published private(set) var isRepo = true
    @Published private(set) var loading = false
    @Published private(set) var stitchMap = StitchMap(excerpts: [])
    @Published private(set) var blockMap = BlockMap()
    @Published var comments: [ReviewComment] = [] {
        didSet { if comments != oldValue { refreshNotes() } }
    }
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
    ///
    /// Empty in the Files scope: that scope is not showing a diff at all, so the document is
    /// built purely from whatever `⌘P` has opened.
    var displayedFiles: [DiffFile] {
        if scope == .files { return [] }
        guard let focusedFile else { return files }
        return files.filter { $0.path == focusedFile }
    }

    /// The staged half, narrowed the same way. Empty outside working-tree mode.
    var displayedStagedFiles: [DiffFile] {
        if scope == .files { return [] }
        guard let focusedFile else { return stagedFiles }
        return stagedFiles.filter { $0.path == focusedFile }
    }

    /// The stitched document. One storage, shared with the editor.
    let storage = NSTextStorage()

    /// Row style per stitched line, precomputed at build time — the render delegate and
    /// the gutter both read this, and it must be a cheap lookup (it runs per fragment).
    private(set) var rowStyles: [RowStyle] = []

    /// Per deletion band, the tint + word spans for each of its removed lines. Keyed by
    /// block id, which is stable across rebuilds.
    private(set) var deletionStyles: [String: [RowStyle]] = [:]

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
        textForSource: { [weak self] source, variant in
            self?.text(for: source, variant: variant) ?? ""
        },
        rangeForStitchedLine: { [weak self] line in self?.range(forStitchedLine: line) },
        stitchedLineRange: { [weak self] range in self?.stitchedLines(in: range) }
    )

    /// Owned here for the same reason as the highlighter and the renderer: a fresh instance
    /// per `body` evaluation would reinstall itself on every scroll tick.
    lazy var writeBack: WriteBackCoordinator = WriteBackCoordinator(session: self)

    /// The band-control layer. Owned here rather than built in a `body` for the same reason
    /// as the highlighter — and because it must survive the editor remount a rebuild causes,
    /// re-parenting itself into the new scroll view rather than being recreated.
    lazy var overlay: WorkbenchOverlayView = {
        let view = WorkbenchOverlayView()
        view.scrollViewProvider = { [weak self] in self?.editorScrollViewProvider?() }
        view.lineMetrics = { [weak self] index in self?.editorLineMetrics?(index) }
        view.lineIndex = { [weak self] documentY in self?.editorLineIndex?(documentY) }
        view.blocksAbove = { [weak self] index in
            self?.blockMap.blocks(beforeStitchedLine: index) ?? []
        }
        view.controlBands = { [weak self] in
            (self?.blockMap.blocks ?? []).compactMap { block in
                guard case .conflictControls = block.kind else { return nil }
                return (block, block.beforeStitchedLine)
            }
        }
        view.onResolve = { [weak self] conflictID, resolution in
            self?.resolve(conflictID: conflictID, as: resolution)
        }
        return view
    }()

    /// Push the current document's shape at the overlay. Called wherever the gutter is
    /// refreshed, since the two track the same geometry.
    func refreshOverlay() {
        overlay.rowCount = gutterRowCount
        overlay.rowHeight = WorkbenchMetrics.rowHeight
        overlay.observeScroll()
        overlay.needsDisplay = true
    }

    lazy var renderer: BlockRenderer = BlockRenderer(
        stitchedLineForOffset: { [weak self] offset in self?.stitchedLine(forOffset: offset) },
        styleForStitchedLine: { [weak self] line in self?.style(atStitchedLine: line) ?? .plain },
        blocksForStitchedLine: { [weak self] line in
            self?.blockMap.blocks(beforeStitchedLine: line) ?? []
        },
        displayName: { [weak self] source in self?.relativePath(of: source) ?? source.path },
        deletedLines: { [weak self] block in self?.deletedLineRows(for: block) ?? [] },
        rowWidth: { [weak self] in
            self?.editorScrollViewProvider?()?.documentView?.frame.width ?? 0
        },
        onExpandGap: { [weak self] source, collapsed, fromTop in
            guard let self else { return }
            self.reveal(collapsed, inFile: self.relativePath(of: source), fromTop: fromTop)
        }
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

    /// The text behind a highlight variant.
    ///
    /// The merge variants read from memory, never from disk: a conflicted file on disk holds
    /// git's markers, which is neither what the document shows nor anything worth colouring.
    func text(for source: SourceID, variant: HighlightVariant) -> String {
        switch variant {
        case .new:
            return buffer(for: source).text
        case .old:
            return buffer(for: source).baseText ?? ""
        case .mergePreview:
            return MergeText.blob(mergePreviews[relativePath(of: source)] ?? [])
        case .snippet:
            // No band parses a loose fragment any more — both sides of a conflict are real
            // rows of the merge preview now, so they highlight through `.mergePreview`.
            return ""
        }
    }

    /// The file, text variant, and **0-based line** a stitched row shows.
    ///
    /// In a diff this is always the working copy: every text row is a real line of a file on
    /// disk (removals are bands, not rows). In a **conflicted** file it is the merge preview
    /// — the file on disk still holds git's markers, so nothing in the document sits at the
    /// line number the document claims, and asking for `.new` would paint each row with
    /// whatever line happens to be there.
    ///
    /// Not derived from `StitchMap`: an excerpt's `lineRange` holds *row* indices, and
    /// reading them as source lines fed the highlighter arbitrary lines of the file — which
    /// is what painted syntax colors on unrelated words. The per-row numbers are the real
    /// mapping, and they are 1-based.
    func sourceAnchor(atStitchedLine line: Int)
        -> (source: SourceID, variant: HighlightVariant, line: Int)? {
        guard rowOrigins.indices.contains(line),
              let new = rowOrigins[line].newLineNumber else { return nil }
        let origin = rowOrigins[line]
        let variant: HighlightVariant =
            mergePreviews[origin.path] != nil ? .mergePreview : .new
        return (source(of: origin.path), variant, new - 1)
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
                self.stagedFiles = result.stagedFiles
                // A focused file that fell out of the diff would leave an empty editor
                // with nothing explaining why.
                if let focused = self.focusedFile,
                   !result.files.contains(where: { $0.path == focused }) {
                    self.focusedFile = nil
                }
                // A directory that isn't a repo has no diff to show, so the editor is the
                // only surface with anything on it. Landing on "Not a git repository" and
                // having no scope offered to leave it for is a dead end.
                if !result.isRepo, self.scope != .files { self.scope = .files }
                self.baseLabel = result.baseLabel
                if let name = result.baseName { self.baseName = name }
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

    /// Turn the parsed diff into excerpts, blocks, a stitched string, and the per-row
    /// style table.
    ///
    /// The row layout is `RowPlanner`'s, not this method's: what each row is and where
    /// each band sits is the mapping every W2 feature depends on, so it lives in a pure,
    /// tested type. This walk only materializes the text and the styles the plan implies.
    private func rebuild() {
        // Neither a merge nor a hand-opened file is a diff, so they materialize from their
        // own plan. Conflicted files live in the Files scope alongside the ones you opened —
        // a file you have to fix is still a file, and a separate tab for it meant the thing
        // most demanding your attention was one click out of sight.
        if scope == .files {
            rebuildFiles()
            return
        }
        mergePreviews.removeAll()
        let shown = displayedFiles
        let shownStaged = displayedStagedFiles
        let plan = RowPlanner.plan(files: shown, staged: shownStaged,
                                   revealed: revealedLines, opened: openedFiles)
        // Keyed by side as well as path: working-tree mode shows a partially staged file
        // twice, once per diff, and its hunk 0 is a different hunk in each.
        var hunks: [HunkKey: DiffHunk] = [:]
        for (isStaged, list) in [(false, shown), (true, shownStaged)] {
            for file in list where !file.isBinary {
                for (index, hunk) in file.hunks.enumerated() {
                    hunks[HunkKey(path: file.path, hunkIndex: index, isStaged: isStaged)] = hunk
                }
            }
        }

        // One pairing per hunk, built on first use: the pre-hunk version rebuilt both side
        // arrays per line, so a 1000-line hunk did ~1M array appends before drawing.
        var pairings: [HunkKey: HunkPairing] = [:]
        func pairing(_ key: HunkKey) -> HunkPairing? {
            if let existing = pairings[key] { return existing }
            guard let hunk = hunks[key] else { return nil }
            let made = HunkPairing(kinds: hunk.lines.map(\.kind), texts: hunk.lines.map(\.text))
            pairings[key] = made
            return made
        }

        var stitched = ""
        var styles: [RowStyle] = []
        var maxOld = 0, maxNew = 0
        // Gap-revealed rows are read out of the working copy; split once per file, not
        // once per revealed stretch.
        var fileLines: [String: [String]] = [:]
        // A file holding unsaved edits reads from its **buffer**, never from the diff.
        //
        // The diff describes what is on disk. Rebuilding an edited file's rows from it —
        // which is what reopening the workbench does — silently replaces your unsaved lines
        // with the saved ones, while the buffer still holds the edit. The document and the
        // buffer then disagree, and `canApplyEdit`'s staleness guard correctly refuses every
        // further edit to those lines: the line goes read-only for no visible reason.
        let dirty = dirtyPaths

        for origin in plan.origins {
            let key = HunkKey(path: origin.path, hunkIndex: origin.hunkIndex,
                              isStaged: origin.isStaged)
            if origin.lineIndex >= 0, !dirty.contains(origin.path), let hunk = hunks[key],
               hunk.lines.indices.contains(origin.lineIndex) {
                let diffLine = hunk.lines[origin.lineIndex]
                stitched += diffLine.text + "\n"
                styles.append(Self.style(
                    for: diffLine.kind,
                    text: diffLine.text,
                    counterpart: pairing(key)?.counterpart(atLineIndex: origin.lineIndex)))
            } else {
                // A gap-revealed row, or any row of an edited file: read the live text.
                if fileLines[origin.path] == nil {
                    fileLines[origin.path] = text(for: source(of: origin.path))
                        .components(separatedBy: "\n")
                }
                let lines = fileLines[origin.path] ?? []
                let index = (origin.newLineNumber ?? 1) - 1
                stitched += (lines.indices.contains(index) ? lines[index] : "") + "\n"
                // Keep the diff's tint on an edited row so the hunk still reads as changed;
                // the word spans can't be trusted against text the diff never saw.
                if origin.lineIndex >= 0, let hunk = hunks[key],
                   hunk.lines.indices.contains(origin.lineIndex) {
                    let kind = hunk.lines[origin.lineIndex].kind
                    styles.append(RowStyle(tint: kind == .added ? .added
                                             : (kind == .removed ? .removed : .none),
                                           wordSpans: []))
                } else {
                    styles.append(.plain)
                }
            }
            maxOld = max(maxOld, origin.oldLineNumber ?? 0)
            maxNew = max(maxNew, origin.newLineNumber ?? 0)
        }

        var blocks: [Block] = []
        var bandStyles: [String: [RowStyle]] = [:]
        let rowHeight = WorkbenchMetrics.rowHeight
        for planned in plan.blocks {
            switch planned.band {
            case .fileHeader(let path):
                blocks.append(Block(id: planned.id, kind: .fileHeader(source(of: path)),
                                    beforeStitchedLine: planned.beforeRow, height: rowHeight + 12))
            case .hunkGap(let path, let collapsed):
                blocks.append(Block(id: planned.id,
                                    kind: .hunkGap(source: source(of: path), collapsed: collapsed),
                                    beforeStitchedLine: planned.beforeRow, height: rowHeight + 8))
            case .deletedLines(let path, let hunkIndex, let lineIndices, let startingOldLine):
                // Bands carry no side of their own; they belong to the row above them, and
                // a file only ever shows one deletion band per (path, hunk) per side.
                let key = HunkKey(path: path, hunkIndex: hunkIndex,
                                  isStaged: plan.origins.indices.contains(planned.beforeRow)
                                      ? plan.origins[planned.beforeRow].isStaged
                                      : (plan.origins.last?.isStaged ?? false))
                guard let hunk = hunks[key] else { continue }
                let removed = lineIndices.filter { hunk.lines.indices.contains($0) }
                guard !removed.isEmpty else { continue }
                blocks.append(Block(
                    id: planned.id,
                    kind: .deletedLines(source: source(of: path),
                                        lines: removed.map { hunk.lines[$0].text },
                                        startingOldLine: startingOldLine),
                    beforeStitchedLine: planned.beforeRow,
                    height: rowHeight * CGFloat(removed.count)))
                bandStyles[planned.id] = removed.map { index in
                    Self.style(for: .removed, text: hunk.lines[index].text,
                               counterpart: pairing(key)?.counterpart(atLineIndex: index))
                }
                maxOld = max(maxOld, startingOldLine + removed.count - 1)
            case .sectionHeader(let title):
                blocks.append(Block(id: planned.id, kind: .sectionHeader(title: title),
                                    beforeStitchedLine: planned.beforeRow,
                                    height: rowHeight + 10))
            case .conflictControls, .conflictMarker:
                // Only `RowPlanner.planConflicts` emits these, and that plan is
                // materialized by `rebuildFiles`. A diff can't produce one.
                continue
            }
        }

        // Real 0-based new-side source ranges, which they could not be while removals were
        // rows. `StitchMap`'s lookups are consistent with the document again.
        let excerpts = plan.excerpts.map {
            Excerpt(id: $0.id, source: source(of: $0.path),
                    lineRange: $0.sourceLines, kind: $0.kind)
        }

        storage.setAttributedString(NSAttributedString(string: stitched,
                                                       attributes: WorkbenchMetrics.baseAttributes))
        lineStarts = SourceHighlightCache.lineStartOffsets(stitched)
        stitchMap = StitchMap(excerpts: excerpts)
        blockMap = BlockMap(blocks: blocks)
        rowStyles = styles
        deletionStyles = bandStyles
        deletionRows.removeAll()
        rowOrigins = plan.origins
        // Notes are placed after the walk, not during it: an anchor is resolved against the
        // finished row table. Emitted at `row + 1` so the band draws *under* the line it is
        // about (a block renders above the row it is attached to), and appended last so it
        // sits below any deletion band sharing that position.
        for note in placedNotes() { blockMap.insert(noteBlock(note)) }
        maxOldLineNumber = maxOld
        maxNewLineNumber = maxNew
        selectedLines.removeAll()   // row indices don't survive a rebuild
        revision += 1
    }

    // MARK: - Merge conflicts

    @Published private(set) var mergeFiles: [MergeFile] = []
    @Published private(set) var mergeState: MergeState = .idle
    /// Paths where our diff3 disagreed with the marker count git wrote — the tripwire for
    /// our merge diverging from git's.
    @Published private(set) var divergentFiles: [String] = []
    /// Per-conflict decisions, held in memory until a whole file is settled. Nothing reaches
    /// disk before that, so a half-triaged file is left exactly as git left it.
    @Published private(set) var resolutions: [String: Resolution] = [:]

    /// The merge preview each conflicted file's rows were materialized from, so the
    /// highlighter colours the text the document is actually showing.
    private var mergePreviews: [String: [String]] = [:]

    var hasConflicts: Bool { !mergeFiles.isEmpty }
    var conflictPaths: Set<String> { Set(mergeFiles.map(\.path)) }

    /// Conflicted files, narrowed to the focused one.
    var displayedConflictFiles: [MergeFile] {
        guard let focusedFile else { return mergeFiles }
        return mergeFiles.filter { $0.path == focusedFile }
    }

    func unresolvedCount(inFile path: String) -> Int {
        guard let file = mergeFiles.first(where: { $0.path == path }) else { return 0 }
        return MergeOutput.unresolved(file, resolutions: resolutions).count
    }

    var totalUnresolved: Int {
        mergeFiles.reduce(0) { $0 + MergeOutput.unresolved($1, resolutions: resolutions).count }
    }

    func canResolveFile(_ path: String) -> Bool {
        !writing && mergeFiles.contains { $0.path == path } && unresolvedCount(inFile: path) == 0
    }

    /// Read the unmerged index. Cheap enough to run on every load — `ls-files -u` on a clean
    /// repo returns nothing and costs one process.
    func loadConflicts() {
        loading = true
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let result = ConflictReader.read(cwd: cwd)
            DispatchQueue.main.async {
                let paths = Set(result.files.map(\.path))
                self.mergeFiles = result.files
                self.mergeState = result.state
                self.divergentFiles = result.divergent
                // Choices for conflicts that no longer exist are dropped. Ids embed the
                // path and the region's ordinal, so a file whose regions changed shape
                // loses its decisions rather than silently applying them to a different
                // region — the safe direction.
                self.resolutions = self.resolutions.filter { entry in
                    guard let path = entry.key.components(separatedBy: "#").first,
                          paths.contains(path) else { return false }
                    return result.files.contains { file in
                        file.conflicts.contains { $0.id == entry.key }
                    }
                }
                if let focused = self.focusedFile, !paths.contains(focused) {
                    self.focusedFile = nil
                }
                self.rebuild()
                self.loading = false
            }
        }
    }

    /// Materialize the Files document: every unmerged file as a three-way merge, then the
    /// files opened by hand through `⌘P`.
    private func rebuildFiles() {
        let shown = displayedConflictFiles
        let plan = RowPlanner.planConflicts(shown, resolutions: resolutions,
                                            opened: openedFiles)

        var previews: [String: [String]] = [:]
        for file in shown {
            previews[file.path] = MergeOutput.preview(file, resolutions: resolutions)
        }

        var stitched = ""
        var styles: [RowStyle] = []
        var maxNew = 0
        // An opened file has no merge preview; its rows are read off disk.
        var fileLines: [String: [String]] = [:]
        for origin in plan.origins {
            let lines: [String]
            if let preview = previews[origin.path] {
                lines = preview
            } else {
                if fileLines[origin.path] == nil {
                    fileLines[origin.path] = text(for: source(of: origin.path))
                        .components(separatedBy: "\n")
                }
                lines = fileLines[origin.path] ?? []
            }
            let index = (origin.newLineNumber ?? 1) - 1
            stitched += (lines.indices.contains(index) ? lines[index] : "") + "\n"
            // Only rows inside a conflict are tinted, and the two sides differently. An
            // auto-resolved region is not a decision and must read as ordinary code.
            let tint: RowTint
            switch origin.conflictSide {
            case .some(.ours):   tint = .conflictOurs
            case .some(.theirs): tint = .conflictTheirs
            case .none:          tint = .none
            }
            styles.append(RowStyle(tint: tint, wordSpans: []))
            maxNew = max(maxNew, origin.newLineNumber ?? 0)
        }

        var blocks: [Block] = []
        let rowHeight = WorkbenchMetrics.rowHeight
        let byPath = Dictionary(uniqueKeysWithValues: shown.map { ($0.path, $0) })

        for planned in plan.blocks {
            switch planned.band {
            case .fileHeader(let path):
                blocks.append(Block(id: planned.id, kind: .fileHeader(source(of: path)),
                                    beforeStitchedLine: planned.beforeRow,
                                    height: rowHeight + 12))
            case .conflictControls(let path, let conflictID, let index, let total):
                guard let file = byPath[path] else { continue }
                blocks.append(Block(
                    id: planned.id,
                    kind: .conflictControls(source: source(of: path), conflictID: conflictID,
                                            index: index, total: total,
                                            resolution: resolutions[conflictID],
                                            kind: file.kind, oursLabel: file.oursLabel,
                                            theirsLabel: file.theirsLabel),
                    beforeStitchedLine: planned.beforeRow,
                    height: ConflictBandMetrics.controlsHeight))
            case .conflictMarker(let path, let conflictID, let label, let side, let isEnd):
                blocks.append(Block(
                    id: planned.id,
                    kind: .conflictMarker(source: source(of: path), conflictID: conflictID,
                                          label: label, side: side, isEnd: isEnd),
                    beforeStitchedLine: planned.beforeRow,
                    height: ConflictBandMetrics.markerHeight))
            case .hunkGap, .deletedLines, .sectionHeader:
                continue
            }
        }

        let excerpts = plan.excerpts.map {
            Excerpt(id: $0.id, source: source(of: $0.path),
                    lineRange: $0.sourceLines, kind: $0.kind)
        }

        storage.setAttributedString(NSAttributedString(string: stitched,
                                                       attributes: WorkbenchMetrics.baseAttributes))
        lineStarts = SourceHighlightCache.lineStartOffsets(stitched)
        stitchMap = StitchMap(excerpts: excerpts)
        blockMap = BlockMap(blocks: blocks)
        rowStyles = styles
        rowOrigins = plan.origins
        deletionStyles = [:]
        deletionRows.removeAll()
        mergePreviews = previews
        maxOldLineNumber = 0
        maxNewLineNumber = maxNew
        selectedLines.removeAll()
        revision += 1
    }

    /// Take a side for one conflict.
    ///
    /// Rebuilds — which rows exist depends on the choice — and that remounts the editor, so
    /// it scrolls back to the conflict afterwards. Landing back on the thing you just
    /// decided is what you want anyway.
    func resolve(conflictID: String, as resolution: Resolution) {
        guard resolutions[conflictID] != resolution else { return }
        resolutions[conflictID] = resolution
        invalidatePreview(forConflict: conflictID)
        rebuild()
        if let row = rowOrigins.firstIndex(where: { $0.conflictID == conflictID }) {
            requestScroll(toStitchedLine: row)
        }
    }

    /// Take the same side for every conflict in a file — the common move in a rebase where
    /// one branch is simply the one you want.
    func resolveAll(inFile path: String, as resolution: Resolution) {
        guard let file = mergeFiles.first(where: { $0.path == path }) else { return }
        for conflict in file.conflicts { resolutions[conflict.id] = resolution }
        highlighter.invalidate(source: source(of: path), variant: .mergePreview)
        rebuild()
    }

    /// A resolution rewrites that file's preview, but nothing about its working copy or its
    /// base blob — so only that one parse is dropped.
    private func invalidatePreview(forConflict conflictID: String) {
        guard let path = conflictID.components(separatedBy: "#").first else { return }
        highlighter.invalidate(source: source(of: path), variant: .mergePreview)
    }

    /// Write a fully decided file and stage it.
    ///
    /// Whole-file conflicts never take this path: they have no line list, and reconstructing
    /// one so it could be written would make the fabrication real. Those go to git.
    func resolveFile(path: String) {
        guard !writing, let file = mergeFiles.first(where: { $0.path == path }) else { return }
        guard MergeOutput.unresolved(file, resolutions: resolutions).isEmpty else {
            lastError = "\(path) still has undecided conflicts."
            return
        }

        let cwd = self.cwd
        lastError = nil
        writing = true

        if file.kind.isWholeFile {
            let side: MergeSide = resolutions[file.conflicts.first?.id ?? ""] == .theirs
                ? .theirs : .ours
            let commands = WholeFileResolve.commands(kind: file.kind, side: side, path: path)
            DispatchQueue.global(qos: .userInitiated).async {
                var failure: String?
                for args in commands {
                    if let error = GitStaging.run(args, cwd: cwd).errorText {
                        failure = error
                        break
                    }
                }
                DispatchQueue.main.async {
                    self.writing = false
                    self.lastError = failure
                    self.loadConflicts()
                }
            }
            return
        }

        guard let text = MergeOutput.text(file, resolutions: resolutions) else {
            writing = false
            lastError = "Couldn't build the merged text for \(path)."
            return
        }
        let absolute = (cwd as NSString).appendingPathComponent(path)
        DispatchQueue.global(qos: .userInitiated).async {
            var failure: String?
            do {
                try text.write(toFile: absolute, atomically: true, encoding: .utf8)
                failure = GitStaging.stageFiles([path], cwd: cwd).errorText
            } catch {
                failure = "Couldn't write \(path): \(error.localizedDescription)"
            }
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = failure
                self.highlighter.invalidate(source: self.source(of: path))
                self.loadConflicts()
            }
        }
    }

    /// Abandon the whole operation. A resolver without an escape hatch is a trap.
    func abortOperation() {
        guard !writing, mergeState.isActive else { return }
        let verb: String
        switch mergeState.operation {
        case .merge:      verb = "merge"
        case .rebase:     verb = "rebase"
        case .cherryPick: verb = "cherry-pick"
        case .none:       return
        }
        let cwd = self.cwd
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = GitStaging.run([verb, "--abort"], cwd: cwd)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                self.resolutions.removeAll()
                self.loadConflicts()
            }
        }
    }

    /// A hunk's identity across the walk. Two files can each have a hunk 0.
    private struct HunkKey: Hashable {
        let path: String
        let hunkIndex: Int
        var isStaged = false
    }

    /// The file a path names.
    ///
    /// An absolute path passes straight through: the Files scope is a plain editor and can
    /// open anything, including files nowhere near the pane's directory. Joining one onto
    /// `cwd` would produce `/Users/me/repo/Users/me/elsewhere.txt`.
    func source(of path: String) -> SourceID {
        path.hasPrefix("/") ? SourceID(path)
                            : SourceID((cwd as NSString).appendingPathComponent(path))
    }

    /// Row tint plus word spans, against the hunk's precomputed pairing.
    private static func style(for kind: DiffLineKind, text: String,
                              counterpart: String?) -> RowStyle {
        switch kind {
        case .context:
            return .plain
        case .added, .removed:
            guard let counterpart else {
                return RowStyle(tint: kind == .added ? .added : .removed, wordSpans: [])
            }
            let (old, new) = kind == .added ? (counterpart, text) : (text, counterpart)
            let spans = WordDiff.spans(old: old, new: new)
            return RowStyle(tint: kind == .added ? .added : .removed,
                            wordSpans: kind == .added ? spans.new : spans.old)
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

    /// Rows the gutter draws for, which is one more than the text rows when the document
    /// ends in a newline: the storage carries a final empty line there, and a band that
    /// trails the whole document (a hunk ending in removals) is hosted by it. Without the
    /// extra row the gutter would skip that band's numbers entirely.
    var gutterRowCount: Int {
        rowOrigins.count + (lineStarts.count > rowOrigins.count ? 1 : 0)
    }

    /// A deletion band's rows: each removed line syntax-coloured from the base blob, with
    /// the tint and word spans `rebuild` computed for it.
    ///
    /// Built on demand and cached rather than at rebuild time: colouring one is a
    /// tree-sitter parse of the *old* side of a file, and a 287-file diff must not pay for
    /// the bands nobody scrolls to. The whole array is cached, not just the text, because
    /// this is read from `draw` — rezipping it per frame is exactly the kind of per-frame
    /// allocation the first live run was full of. Cleared on rebuild, and bounded, since
    /// scrolling a big diff end to end would otherwise retain every removed line in it.
    func deletedLineRows(for block: Block) -> [DeletedLineRow] {
        if let cached = deletionRows[block.id] { return cached }
        guard case .deletedLines(let source, let lines, let startingOldLine) = block.kind else {
            return []
        }
        let theme = WorkbenchEditorTheme.current
        let font = WorkbenchMetrics.font
        let styles = deletionStyles[block.id] ?? []
        let rendered = lines.enumerated().map { offset, text -> DeletedLineRow in
            let string = NSMutableAttributedString(string: text,
                                                   attributes: WorkbenchMetrics.baseAttributes)
            for highlight in highlighter.baseHighlights(source: source,
                                                        line: startingOldLine - 1 + offset) {
                let location = highlight.range.location
                let length = min(highlight.range.length, string.length - location)
                guard location >= 0, location < string.length, length > 0 else { continue }
                string.addAttributes([.font: theme.fontFor(for: highlight.capture, from: font),
                                      .foregroundColor: theme.colorFor(highlight.capture)],
                                     range: NSRange(location: location, length: length))
            }
            let style = offset < styles.count ? styles[offset]
                                             : RowStyle(tint: .removed, wordSpans: [])
            return DeletedLineRow(text: string, tint: style.tint,
                                  wordSpans: Self.spanOffsets(in: string, style.wordSpans))
        }
        if deletionRows.count > Self.maxCachedBands { deletionRows.removeAll() }
        deletionRows[block.id] = rendered
        return rendered
    }

    /// Turn character-indexed word spans into x offsets, measured against the attributed
    /// text itself.
    ///
    /// Measured rather than `characterIndex × advance`: each token carries whatever font the
    /// theme gave its capture, so a uniform-advance assumption drifts further right the
    /// longer the line — and it is wrong outright for anything that isn't one cell wide.
    /// Done here, once per band, because `draw` runs per frame.
    private static func spanOffsets(in text: NSAttributedString,
                                    _ spans: [WordSpan]) -> [(x: CGFloat, width: CGFloat)] {
        guard !spans.isEmpty, text.length > 0 else { return [] }
        let string = text.string
        // `WordSpan.range` counts Characters; an NSAttributedString range counts UTF-16.
        func utf16Offset(_ characterIndex: Int) -> Int {
            guard let index = string.index(string.startIndex, offsetBy: characterIndex,
                                           limitedBy: string.endIndex) else { return text.length }
            return string.utf16.distance(from: string.utf16.startIndex, to: index)
        }
        func width(upTo offset: Int) -> CGFloat {
            offset <= 0 ? 0
                : text.attributedSubstring(from: NSRange(location: 0, length: offset)).size().width
        }
        return spans.filter(\.changed).compactMap { span in
            let lower = utf16Offset(span.range.lowerBound)
            let upper = min(utf16Offset(span.range.upperBound), text.length)
            guard lower < upper else { return nil }
            let x = width(upTo: lower)
            return (x: x, width: max(1, width(upTo: upper) - x))
        }
    }

    private var deletionRows: [String: [DeletedLineRow]] = [:]
    private static let maxCachedBands = 400

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

    // MARK: - Edit write-back

    /// Bumped when an edit changed the row tables, so the gutter re-reads them. Distinct
    /// from `revision`, which remounts the editor — doing that per keystroke would throw
    /// away the cursor you are typing with.
    @Published private(set) var editRevision = 0

    /// Whether an edit can be written back, asked by the editor **before** it changes text.
    ///
    /// Refused when the rows aren't one contiguous run of a single file's lines (see
    /// `EditMap.fileEdit`), or when the file on disk no longer matches what the document
    /// shows — in which case the offsets we'd write at are stale and we'd corrupt the file.
    func canApplyEdit(range: NSRange) -> Bool {
        guard let rows = stitchedLines(in: range),
              let edit = EditMap.fileEdit(rows: rows, origins: rowOrigins) else { return false }
        // A conflicted file's rows are a merge preview. The file on disk still holds git's
        // markers, so no row sits at the offset it claims and there is nothing to write
        // back to. Refused here, explicitly, rather than left to the staleness guard below
        // — that would refuse silently, and "the line went read-only for no visible reason"
        // is exactly the defect W2.2's live run turned up. `editBlockedReason` says so.
        guard !conflictPaths.contains(edit.path) else { return false }
        return documentMatchesFile(rows: rows, edit: edit)
    }

    /// Why the cursor's file can't be edited, or nil when it can. Shown in the header, so a
    /// refusal is never mysterious.
    var editBlockedReason: String? {
        guard let line = cursorStitchedLine, rowOrigins.indices.contains(line) else {
            return nil
        }
        let path = rowOrigins[line].path
        guard conflictPaths.contains(path) else { return nil }
        return "\((path as NSString).lastPathComponent) is conflicted — resolve it to edit."
    }

    /// Absorb an edit the editor has already applied to `storage`.
    ///
    /// Called from `didReplaceContentsIn`, so `storage` is new but `rowOrigins`/`lineStarts`
    /// still describe the document as it was — which is exactly what resolving the edit's
    /// old position needs.
    func absorbEdit(range: NSRange, replacement: String) {
        guard let rows = stitchedLines(in: range),
              let edit = EditMap.fileEdit(rows: rows, origins: rowOrigins),
              let (fileRange, buffer) = fileRange(forRows: rows, edit: edit, range: range)
        else { return }

        let updated = (buffer.text as NSString)
            .replacingCharacters(in: fileRange, with: replacement)
        buffer.replaceText(updated)

        let delta = EditMap.rowDelta(replacing: rows, with: replacement)
        let newRowCount = rows.count + delta
        // The tint survives so a line doesn't flicker grey as you type in it, but the word
        // spans cannot: they index into the text that was just replaced.
        let template = style(atStitchedLine: rows.lowerBound)
        let carried = RowStyle(tint: template.tint, wordSpans: [])
        rowStyles.replaceSubrange(rows, with: Array(repeating: carried, count: newRowCount))
        rowOrigins = EditMap.rowsAfterEdit(rowOrigins, replacing: rows,
                                           withRowCount: newRowCount)
        lineStarts = EditMap.lineStartsAfterEdit(lineStarts, replacing: rows,
                                                 editStart: range.location,
                                                 removedLength: range.length,
                                                 replacement: replacement)
        if delta != 0 {
            blockMap.shift(fromStitchedLine: rows.upperBound, by: delta)
            stitchMap.applyEdit(in: buffer.source, atLine: edit.lines.lowerBound,
                                lineDelta: delta)
            // Only ever widens: the gutter's number column twitching narrower while you
            // type would shift the whole document sideways.
            if delta > 0 { maxNewLineNumber += delta }
        }
        highlighter.invalidate(source: buffer.source)
        editRevision += 1
    }

    /// The file offsets an edit over `rows` maps to, plus the buffer holding them.
    private func fileRange(forRows rows: Range<Int>, edit: FileEdit,
                           range: NSRange) -> (NSRange, SourceBuffer)? {
        let buffer = buffer(for: source(of: edit.path))
        let starts = EditMap.lineStartOffsets(buffer.text)
        let last = edit.lines.upperBound - 1
        guard edit.lines.lowerBound < starts.count, last < starts.count,
              rows.lowerBound < lineStarts.count, rows.upperBound - 1 < lineStarts.count
        else { return nil }

        // Columns are the same on both sides: a row *is* its file line.
        let startColumn = range.location - lineStarts[rows.lowerBound]
        let endColumn = range.location + range.length - lineStarts[rows.upperBound - 1]
        let start = starts[edit.lines.lowerBound] + startColumn
        let end = starts[last] + endColumn
        guard startColumn >= 0, endColumn >= 0, start <= end,
              end <= (buffer.text as NSString).length else { return nil }
        return (NSRange(location: start, length: end - start), buffer)
    }

    /// Whether the file still reads the way the document says it does.
    ///
    /// The diff was taken at some point in the past; if an agent has rewritten the file
    /// since, the row we think is line 40 may not be, and writing at that offset would
    /// scramble the file. Compared over the edited lines only, so it costs the edit's size.
    private func documentMatchesFile(rows: Range<Int>, edit: FileEdit) -> Bool {
        let buffer = buffer(for: source(of: edit.path))
        let fileText = buffer.text as NSString
        let starts = EditMap.lineStartOffsets(buffer.text)
        let last = edit.lines.upperBound - 1
        guard edit.lines.lowerBound < starts.count, last < starts.count,
              rows.upperBound - 1 < lineStarts.count else { return false }

        let fileStart = starts[edit.lines.lowerBound]
        let fileEnd = last + 1 < starts.count ? starts[last + 1] - 1 : fileText.length
        let docStart = lineStarts[rows.lowerBound]
        let docEnd = rows.upperBound < lineStarts.count
            ? lineStarts[rows.upperBound] - 1 : storage.length
        guard fileStart <= fileEnd, fileEnd <= fileText.length,
              docStart <= docEnd, docEnd <= storage.length else { return false }

        return fileText.substring(with: NSRange(location: fileStart, length: fileEnd - fileStart))
            == (storage.string as NSString)
                .substring(with: NSRange(location: docStart, length: docEnd - docStart))
    }

    // MARK: - Copy

    /// What a copy of `range` should put on the pasteboard, or nil to let the editor copy
    /// its own characters.
    ///
    /// Removed lines are bands, not rows — a removed line exists in no file, so it has no
    /// position in the document — which means the editor's own copy silently omits them. A
    /// selection dragged across a hunk looks like it took the whole thing and doesn't. This
    /// was a regression from before W2.0, when removals were real rows.
    ///
    /// Removals come back **prefixed with `-`**, matching the sign the gutter draws beside
    /// them, while everything else is bare. Reproducing the screen exactly would interleave
    /// old and new lines with nothing to tell them apart, which pastes as text that looks
    /// like code and isn't — a worse failure than the one being fixed.
    func copyText(forRange range: NSRange) -> String? {
        guard range.length > 0, let rows = stitchedLines(in: range) else { return nil }
        // Only deviate when the selection really spans a band; otherwise the editor's own
        // attributed copy should stand, so syntax colours survive a paste into a rich editor.
        let spanned = rows.dropFirst().contains { !removedLines(above: $0).isEmpty }
        guard spanned else { return nil }

        let document = storage.string as NSString
        var out: [String] = []
        for row in rows {
            // A band draws *above* its row, so the one attached to the first selected row
            // sits above the selection and is not part of it.
            if row > rows.lowerBound {
                out += removedLines(above: row).map { "-" + $0 }
            }
            guard let rowRange = self.range(forStitchedLine: row) else { continue }
            // Clip to the selection so a partial first or last line copies what was dragged
            // over, not the whole line.
            let clipped = NSIntersectionRange(rowRange, range)
            out.append(document.substring(with: clipped.length > 0 ? clipped : rowRange))
        }
        return out.joined(separator: "\n")
    }

    /// The removed lines drawn immediately above a row.
    private func removedLines(above row: Int) -> [String] {
        blockMap.blocks(beforeStitchedLine: row).flatMap { block -> [String] in
            guard case .deletedLines(_, let lines, _) = block.kind else { return [] }
            return lines
        }
    }

    /// Save the file the cursor is in, or every file holding edits when there isn't one.
    ///
    /// Re-diffs afterwards: the displayed diff was taken before the edit, so until it is
    /// re-read the hunks and their line numbers describe the old file.
    func saveEdits() {
        let cursorPath = cursorStitchedLine.flatMap { line -> String? in
            rowOrigins.indices.contains(line) ? rowOrigins[line].path : nil
        }
        let targets = buffers.values.filter {
            $0.isDirty && (cursorPath == nil || relativePath(of: $0.source) == cursorPath)
        }
        guard !targets.isEmpty else { return }
        lastError = nil
        var failure: String?
        for buffer in targets {
            do {
                try buffer.save()
            } catch {
                failure = "Couldn't save \(relativePath(of: buffer.source)): \(error.localizedDescription)"
            }
        }
        lastError = failure
        load()
    }

    /// Files holding unsaved edits, by repo-relative path.
    var dirtyPaths: Set<String> {
        Set(buffers.values.filter(\.isDirty).map { relativePath(of: $0.source) })
    }

    // MARK: - Inline review notes

    /// The pane's PR review threads, pushed in by the view (the store owns them).
    /// Held here so `rebuild` can place them inline without reaching for the store.
    @Published var threads: [GHReviewThread] = [] {
        didSet { if threads != oldValue { refreshNotes() } }
    }

    /// Asks the editor to re-lay-out without rebuilding the document. Installed by the
    /// editor's coordinator, like the other text-view reaches.
    var requestRelayout: (() -> Void)?

    /// Re-place the inline notes in the existing document.
    ///
    /// Deliberately **not** a `rebuild()`: that replaces the storage and bumps `revision`,
    /// which remounts the editor — so adding a comment would throw away your cursor and
    /// scroll position every time. Only the block heights change, so re-laying-out is
    /// enough.
    func refreshNotes() {
        var map = BlockMap()
        for block in blockMap.blocks {
            if case .reviewNote = block.kind { continue }
            map.insert(block)
        }
        for note in placedNotes() { map.insert(noteBlock(note)) }
        blockMap = map
        requestRelayout?()
        editRevision += 1
    }

    private func noteBlock(_ note: PlacedNote) -> Block {
        Block(id: "note-\(note.id)",
              kind: .reviewNote(id: note.id, origin: note.origin,
                                header: note.header, body: note.body),
              // `+ 1` so the band draws *under* the line it is about: a block renders above
              // the row it is attached to.
              beforeStitchedLine: note.afterRow + 1,
              height: Self.noteHeight(header: note.header, body: note.body))
    }

    /// One note to draw under the line it is about.
    private struct PlacedNote {
        let id: String
        let origin: ReviewNoteOrigin
        let header: String
        let body: String
        /// The row it belongs under.
        let afterRow: Int
    }

    /// Resolve every note to the row it sits under, dropping the ones whose line isn't in
    /// the current document — those stay reachable in the rail and the threads panel.
    private func placedNotes() -> [PlacedNote] {
        var placed: [PlacedNote] = []
        for comment in comments {
            guard let row = stitchedLine(forFile: comment.file, line: comment.line,
                                         side: comment.side) else { continue }
            let name = (comment.file as NSString).lastPathComponent
            placed.append(PlacedNote(
                id: comment.id.uuidString,
                origin: comment.githubAuthor == nil ? .mine : .github,
                header: comment.githubAuthor.map { "@\($0)  \(name):\(comment.line)" }
                    ?? "\(name):\(comment.line)",
                body: comment.text, afterRow: row))
        }
        for thread in threads {
            guard let line = thread.line, let root = thread.comments.first,
                  let row = stitchedLine(forFile: thread.path, line: line,
                                         side: thread.side) else { continue }
            let replies = thread.comments.count - 1
            var header = "@\(root.author)"
            if replies > 0 { header += "  ·  \(replies) repl\(replies == 1 ? "y" : "ies")" }
            if thread.isResolved { header += "  ·  resolved" }
            if thread.isOutdated { header += "  ·  outdated" }
            placed.append(PlacedNote(id: thread.id, origin: .github, header: header,
                                     body: root.body, afterRow: row))
        }
        return placed
    }

    /// Width the inline note text wraps at. Fixed rather than the document width: the
    /// document is as wide as its longest line, which on a diff is far wider than anything
    /// readable, and the band would have to re-measure on every horizontal resize.
    static let noteWrapWidth: CGFloat = 560

    /// Height of a note band, measured off the wrapped body.
    private static func noteHeight(header: String, body: String) -> CGFloat {
        let bodyRect = (body as NSString).boundingRect(
            with: CGSize(width: noteWrapWidth - 24, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: NSFont.systemFont(ofSize: 11)])
        // header line + measured body + padding
        return ceil(bodyRect.height) + 15 + 12
    }

    // MARK: - Branches

    @Published private(set) var branches: [String] = []

    /// Read the branch list when the menu is about to be shown, not on every load.
    func loadBranches() {
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let names = GitStaging.listBranches(cwd: cwd)
            DispatchQueue.main.async { self.branches = names }
        }
    }

    /// Switch branches, then re-read everything — the diff, the file list and every buffer
    /// describe the old checkout.
    ///
    /// Refused outright while any buffer holds unsaved edits: `git checkout` would either
    /// fail or succeed and leave the editor holding text for a file that no longer says
    /// that, and quietly losing someone's edits is not a thing to risk for a convenience.
    func checkout(branch: String) {
        guard !writing, branch != branchName else { return }
        let dirty = dirtyPaths
        guard dirty.isEmpty else {
            lastError = "Unsaved edits in \(dirty.sorted().joined(separator: ", ")) — save (⌘S) or discard before switching branch."
            return
        }
        let cwd = self.cwd
        lastError = nil
        writing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = GitStaging.checkout(branch: branch, cwd: cwd)
            DispatchQueue.main.async {
                self.writing = false
                self.lastError = result.errorText
                if result.isOK {
                    self.openedPaths.removeAll()   // may not exist on the new branch
                    self.repoFiles = []
                    self.fileIndex = FileIndex()
                    self.repoFilesLoaded = false
                    self.revealedLines = [:]
                    self.highlighter.invalidateAll()
                    self.dropBuffers()
                }
                self.load()
            }
        }
    }

    /// Forget every buffer, so the next read comes from the new checkout.
    private func dropBuffers() {
        buffers.values.forEach { $0.stopWatching() }
        buffers.removeAll()
    }

    // MARK: - File finder (⌘P)

    /// Files opened whole, in the order they were opened. Appended after the diff.
    @Published private(set) var openedPaths: [String] = []
    /// Every file git knows about, for the finder. Read once per open.
    @Published private(set) var repoFiles: [String] = []
    /// The same paths, pre-chewed for matching. Built once here rather than per keystroke
    /// in the finder — see `FileIndex`.
    private(set) var fileIndex = FileIndex()
    /// Whether the file list has been read yet, so the finder can tell "still reading" from
    /// "read it, and there is nothing".
    @Published private(set) var repoFilesLoaded = false
    @Published var finderOpen = false

    /// Show the finder, loading the repo's file list on first use.
    func openFinder() {
        finderOpen = true
        guard repoFiles.isEmpty else { return }
        let cwd = self.cwd
        DispatchQueue.global(qos: .userInitiated).async {
            let files = FileLister.list(cwd: cwd)
            // Indexed off the main thread too: it allocates two character arrays per path,
            // which on a large repo is not something to do during a layout pass.
            let index = FileIndex(files)
            DispatchQueue.main.async {
                self.repoFiles = files
                self.fileIndex = index
                self.repoFilesLoaded = true
            }
        }
    }

    /// Open a file in full.
    ///
    /// A file that is *in* the diff is focused instead of opened: it already has rows, and
    /// appending a second copy would give it two headers and two sets of row origins for the
    /// same lines.
    func openFile(path: String) {
        finderOpen = false
        if files.contains(where: { $0.path == path }) {
            focusedFile = path
            rebuild()
            if let row = firstStitchedLine(ofFile: path) { requestScroll(toStitchedLine: row) }
            return
        }
        guard !openedPaths.contains(path) else {
            if let row = firstStitchedLine(ofFile: path) { requestScroll(toStitchedLine: row) }
            return
        }
        openedPaths.append(path)
        // Focus narrows the document to one *changed* file, which would hide the file just
        // asked for.
        focusedFile = nil
        rebuild()
        if let row = firstStitchedLine(ofFile: path) { requestScroll(toStitchedLine: row) }
    }

    /// Open a file by absolute path, from outside the pane's directory.
    ///
    /// Stored `cwd`-relative when it happens to live under the pane, so it reads the same as
    /// everything else in the rail, and absolute when it doesn't.
    func openFile(absolutePath: String) {
        openFile(path: FileLister.relative(absolutePath, to: cwd))
    }

    func closeOpenedFile(path: String) {
        guard openedPaths.contains(path) else { return }
        openedPaths.removeAll { $0 == path }
        rebuild()
    }

    /// The opened files with their line counts, which is what the planner needs.
    private var openedFiles: [OpenedFile] {
        openedPaths.map { path in
            let text = text(for: source(of: path))
            // A file ending in a newline has a trailing empty line; count rows the way the
            // document does, so the excerpt's length matches its rows.
            return OpenedFile(path: path, lineCount: EditMap.lineStartOffsets(text).count)
        }
    }

    // MARK: - Reconciliation

    /// Keep the unsaved edits, overwriting whatever was written underneath them.
    func keepMine(path: String) {
        guard let buffer = liveBuffer(forPath: path) else { return }
        lastError = nil
        do {
            try buffer.save()
        } catch {
            lastError = "Couldn't save \(path): \(error.localizedDescription)"
        }
        load()
    }

    /// Drop the unsaved edits and take what is on disk now.
    func takeTheirs(path: String) {
        guard let buffer = liveBuffer(forPath: path) else { return }
        buffer.apply(.userDiscarded)
        highlighter.invalidate(source: buffer.source)
        load()
    }

    /// An **already-created** buffer, never a new one: a file with no buffer was never
    /// opened, so it has no edits to reconcile and reading it would only cost a file read.
    private func liveBuffer(forPath path: String) -> SourceBuffer? {
        buffers[source(of: path)]
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
        guard !writing else { return }
        // Stage acts on rows from the **unstaged** diff, unstage on rows from the staged
        // one, and each patch is synthesized from the diff its rows came from. Building
        // both from a single `git diff HEAD` is what got a patch rejected the moment the
        // index already differed from HEAD for that file: the patch's old side described
        // HEAD, and `git apply --cached` was applying it to an index that didn't.
        let side = reverse
        let allGroups = StageSelection.selections(
            forStitchedLines: lines, origins: rowOrigins,
            files: side ? displayedStagedFiles : displayedFiles, staged: side)

        guard !allGroups.isEmpty else {
            lastError = reverse
                ? "Nothing staged in that selection to unstage."
                : "Nothing unstaged in that selection to stage."
            return
        }
        // An edited file's diff is the one read before the edit, so its hunk line numbers
        // describe the old file — a patch built from them would apply somewhere else.
        let dirty = dirtyPaths
        if let edited = allGroups.first(where: { dirty.contains($0.path) }) {
            lastError = "\(edited.path) has unsaved edits — save (⌘S) before staging it."
            return
        }
        // Branch mode still shows one HEAD-based diff, where a file can be neither staged
        // nor unstaged — already committed, so `git add` would move nothing.
        let groups = scope == .workingTree ? allGroups : allGroups.filter {
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

    /// The reviewable anchor a stitched line points at: which file, which line, and which
    /// side of the diff.
    ///
    /// Read off `rowOrigins`, not `StitchMap`: `locate` resolves a row by *summing excerpt
    /// lengths*, which stops matching the document the moment a hunk gap is expanded (those
    /// rows belong to no excerpt), and it would have started anchoring comments to the wrong
    /// file.
    func anchor(atStitchedLine line: Int) -> (file: String, line: Int, side: DiffSide)? {
        guard rowOrigins.indices.contains(line) else { return nil }
        let origin = rowOrigins[line]
        if let new = origin.newLineNumber { return (origin.path, new, .new) }
        if let old = origin.oldLineNumber { return (origin.path, old, .old) }
        return nil
    }

    /// Repo-relative path, which is what `ReviewComment` and the agent prompt expect.
    func relativePath(of source: SourceID) -> String {
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
    ///
    /// An old-side line that was removed has no row of its own, so it resolves to the row
    /// owning the band that shows it: jumping there still puts the deleted line on screen.
    func stitchedLine(forFile file: String, line: Int, side: DiffSide) -> Int? {
        for (idx, origin) in rowOrigins.enumerated() where origin.path == file {
            switch side {
            case .new where origin.newLineNumber == line:
                return idx
            case .old where origin.oldLineNumber == line
                || origin.deletedRefs.contains(where: { $0.oldLineNumber == line }):
                return idx
            default:
                continue
            }
        }
        return nil
    }

    /// Whether the current scope has anything to show.
    ///
    /// **Both** halves, because in working-tree mode staging everything empties `files`
    /// entirely — and reporting "no changes" over a full index is exactly backwards.
    var hasAnyChanges: Bool { !files.isEmpty || !stagedFiles.isEmpty }

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
