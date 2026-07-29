import SwiftUI
import AppKit
import CodeEditLanguages

/// Installs the workbench's `BlockRenderer` on the live text view's layout manager.
///
/// A coordinator rather than construction-time wiring because the layout manager only
/// exists once `TextViewController` has loaded its view — `prepareCoordinator` is the
/// first moment it's reachable.
/// Also the one place the live `TextViewController` is reachable, so it hands it to
/// `onReady` — the chrome drives the text view (jump to a hunk) through that instead of
/// `SourceEditorState.cursorPositions`, which upstream compares against itself before
/// applying and therefore never does.
final class RenderDelegateInstaller: TextViewCoordinator {
    private let renderer: BlockRenderer
    /// Held so the layout manager's `weak var renderDelegate` has an owner.
    private var retained: BlockRenderer?
    private let onLayoutChanged: () -> Void
    private let onReady: (TextViewController) -> Void
    private let onDestroy: () -> Void

    init(renderer: BlockRenderer,
         onLayoutChanged: @escaping () -> Void,
         onReady: @escaping (TextViewController) -> Void = { _ in },
         onDestroy: @escaping () -> Void = {}) {
        self.renderer = renderer
        self.onLayoutChanged = onLayoutChanged
        self.onReady = onReady
        self.onDestroy = onDestroy
    }

    func prepareCoordinator(controller: TextViewController) {
        retained = renderer
        controller.textView.layoutManager.renderDelegate = renderer
        controller.textView.layoutManager.setNeedsLayout()
        onReady(controller)
    }

    func textViewDidChangeText(controller: TextViewController) { onLayoutChanged() }

    func destroy() {
        retained = nil
        onDestroy()
    }
}

/// Routes the editor's text changes back to the files they came from.
///
/// A `TextViewDelegate` rather than a plain coordinator because write-back needs both hooks
/// upstream only gives the delegate: the range and replacement of each change, and the
/// chance to **refuse** one. Refusing matters — a row is a real line of a real file, but a
/// file's rows are discontinuous, so an edit spanning two of them (backspacing the first
/// line of a hunk into the last line of the one above) would rewrite everything hidden in
/// the gap between them.
final class WriteBackCoordinator: TextViewCoordinator, TextViewDelegate {
    private weak var session: WorkbenchSession?

    init(session: WorkbenchSession) { self.session = session }

    func prepareCoordinator(controller: TextViewController) { }

    /// `assumeIsolated` rather than `@MainActor`: these callbacks come from AppKit's text
    /// editing path, which is main-thread by construction, but the upstream protocol is not
    /// isolated and conforming with isolated methods doesn't type-check.
    func textView(_ textView: TextView, shouldReplaceContentsIn range: NSRange,
                  with string: String) -> Bool {
        MainActor.assumeIsolated { session?.canApplyEdit(range: range) ?? false }
    }

    /// Applied after the fact, deliberately: `storage` already holds the new text, while
    /// the row tables still describe the old document — which is what resolving where the
    /// edit *was* requires.
    func textView(_ textView: TextView, didReplaceContentsIn range: NSRange,
                  with string: String) {
        MainActor.assumeIsolated { session?.absorbEdit(range: range, replacement: string) }
    }

    /// Copy has to reconstruct the removed lines a selection spans — they are bands, not
    /// characters in the document, so the editor's own copy drops them.
    func textView(_ textView: TextView, stringForCopyOf range: NSRange) -> String? {
        MainActor.assumeIsolated { session?.copyText(forRange: range) }
    }
}

/// The workbench's text surface: our gutter beside CESE's editor over a shared storage.
///
/// Wrapping is off deliberately — a diff scrolls horizontally rather than reflowing, so
/// one stitched line is exactly one row. That invariant is what lets the gutter place
/// rows arithmetically from `WorkbenchMetrics.rowHeight` instead of querying layout for
/// every visible row on every scroll tick.
struct EditorHost: View {
    @ObservedObject var session: WorkbenchSession
    @State private var editorState = SourceEditorState()
    /// Half the content area by default. Not persisted yet — a drag handle and a
    /// `# shepherd:` key are the follow-up the design records.
    @State private var splitWidth: CGFloat = 420

    private var configuration: SourceEditorConfiguration {
        SourceEditorConfiguration(
            appearance: .init(
                theme: WorkbenchEditorTheme.current,
                font: WorkbenchMetrics.font,
                lineHeightMultiple: Theme.lineHeightMultiple,
                wrapLines: false
            ),
            // Editable: `WriteBackCoordinator` maps each change onto the file it came from
            // and keeps the row tables in step. Edits stay in memory until ⌘S — nothing
            // touches disk before that, which bounds what a mapping bug can cost.
            behavior: .init(isEditable: true),
            // Our own gutter replaces CESE's (which can't show dual line numbers), and
            // a minimap over a stitched multibuffer would map to nothing meaningful.
            peripherals: .init(showGutter: false, showMinimap: false, showFoldingRibbon: false)
        )
    }

    var body: some View {
        HStack(spacing: 0) {
            // The old side leads, and the gutter stays with the text it numbers — a
            // new-side gutter sitting to the left of the *old* column reads as the old
            // side's numbers and is two numbering systems deep before any code appears.
            if session.showingSplit {
                OldSideColumnHost(session: session)
                    .frame(width: max(220, splitWidth))
                Rectangle().fill(Color(hex: Theme.Diff.separator)).frame(width: 1)
            }
            WorkbenchGutter(session: session)
                .frame(width: DiffGutterView.width(
                    maxLineNumber: max(session.maxOldLineNumber, session.maxNewLineNumber),
                    hasBlame: !session.blameRows.isEmpty))
            Rectangle().fill(Color(hex: Theme.Diff.separator)).frame(width: 1)
            SourceEditor(
                session.storage,
                language: .default,
                configuration: configuration,
                state: $editorState,
                // Both owned by the session, not built here: `SourceEditor` compares
                // highlight providers by object identity, so a fresh instance per body
                // evaluation reads as a provider change and re-runs the full
                // re-highlight plus `reloadUI()` on every scroll tick.
                highlightProviders: [session.highlighter],
                coordinators: [session.writeBack, RenderDelegateInstaller(
                    renderer: session.renderer,
                    onLayoutChanged: {},
                    onReady: { [weak session] controller in
                        session?.editorScrollViewProvider = { [weak controller] in
                            controller?.scrollView
                        }
                        session?.editorLineMetrics = { [weak controller] index in
                            guard let line = controller?.textView.layoutManager
                                .textLineForIndex(index) else { return nil }
                            return (line.yPos, line.height)
                        }
                        session?.editorLineIndex = { [weak controller] documentY in
                            controller?.textView.layoutManager
                                .textLineForPosition(documentY)?.index
                        }
                        // Re-lay-out without replacing the document, for block changes that
                        // aren't a rebuild (inline review notes appearing/disappearing).
                        session?.requestRelayout = { [weak controller] in
                            controller?.textView.layoutManager.setNeedsLayout()
                        }
                        // Re-run syntax highlighting over a range, after write-back has fixed
                        // the row tables.
                        //
                        // `SyntaxHighlighter` is an `NSTextStorageDelegate`, so it re-queries
                        // during the storage edit — *before* `didReplaceContentsIn` calls
                        // `absorbEdit`. At that moment `rowOrigins` and `lineStarts` still
                        // describe the pre-edit document while the storage already holds the new
                        // text, so the row→line mapping is wrong and the edited line comes back
                        // with no highlights at all. Nothing re-queried afterwards, which is why
                        // typing in a diff row dropped its colours until the next rebuild.
                        session?.requestRehighlight = { [weak controller] range in
                            controller?.highlighter?.invalidate(IndexSet(integersIn: range))
                        }
                        // `prepareCoordinator` runs inside the controller's `init`;
                        // `loadView()` — which builds the scroll view — only happens once
                        // SwiftUI installs the controller's view, after this pass. One
                        // hop later it exists, so that is when the gutter can hook up.
                        DispatchQueue.main.async { [weak session] in
                            session?.requestGutterAttach?()
                            // Same hop, same reason: the overlay has to find the clip view
                            // this remount just built, to know when to repaint.
                            session?.refreshOverlay()
                        }
                        session?.scrollToStitchedLine = { [weak session, weak controller] line in
                            guard let session, let controller else { return }
                            // CursorPosition is 1-indexed; stitched rows are 0-based.
                            controller.setCursorPositions([CursorPosition(line: line + 1, column: 1)])
                            // Scroll arithmetically rather than via
                            // `scrollSelectionToVisible`, which needs the target already
                            // laid out — on a 30k-row document it isn't, so the jump
                            // silently did nothing. One stitched row is exactly one line
                            // (no wrapping), the same invariant the gutter rests on.
                            guard let scrollView = controller.scrollView else { return }
                            let clip = scrollView.contentView
                            let documentHeight = scrollView.documentView?.frame.height ?? 0
                            let maxY = max(0, documentHeight - clip.bounds.height)
                            let target = CGFloat(line) * WorkbenchMetrics.rowHeight - 40
                            clip.scroll(to: NSPoint(x: clip.bounds.origin.x,
                                                    y: min(max(0, target), maxY)))
                            scrollView.reflectScrolledClipView(clip)
                            session.cursorStitchedLine = line
                        }
                        session?.setSelectedRows = { [weak session, weak controller] rows in
                            guard let session, let controller, !rows.isEmpty,
                                  let first = session.range(forStitchedLine: rows.lowerBound),
                                  let last = session.range(forStitchedLine: rows.upperBound - 1)
                            else { return }
                            // Include the trailing newline. `range(forStitchedLine:)`
                            // excludes it, so a blank line is a zero-length range — and a
                            // zero-length selection is a bare caret, which the
                            // selected-rows reducer skips. Clicking any empty row in the
                            // gutter therefore selected nothing at all.
                            let end = min(session.storage.length,
                                          last.location + last.length + 1)
                            let span = NSRange(location: first.location,
                                               length: max(1, end - first.location))
                            // Gutter clicks must hand focus to the editor, or the
                            // selection is set on a view that isn't first responder and
                            // doesn't show it.
                            if let textView = controller.textView,
                               textView.window?.firstResponder !== textView {
                                textView.window?.makeFirstResponder(textView)
                            }
                            controller.setCursorPositions([CursorPosition(range: span)])
                        }
                    },
                    // No teardown: every installed closure holds the controller weakly,
                    // so a stale one is a no-op and a remount overwrites it. Clearing
                    // them on destroy risked an outgoing coordinator wiping the closures
                    // its replacement had just installed.
                    onDestroy: {}
                )]
            )
            .id(session.revision)   // a rebuilt document re-inits the editor
            // Deliberately **outside** that `.id`: the overlay must survive the remount a
            // rebuild causes, or resolving one conflict takes the accept controls off every
            // conflict in the document.
            .overlay { WorkbenchOverlayHost(session: session) }
        }
        .background(Color(hex: Theme.Diff.buffer))
        .onChange(of: editorState.cursorPositions) { positions in
            // Publish the cursor's line so the chrome can act on "this line" without
            // reaching into the text view.
            session.cursorStitchedLine = positions?.first.flatMap {
                session.stitchedLine(forOffset: $0.range.location)
            }
            // The text selection *is* the staging selection. Zero-length positions are
            // bare cursors, not a selection — they leave it empty so ⌘⏎ falls back to
            // the cursor's hunk.
            var rows: Set<Int> = []
            for position in positions ?? [] where position.range.length > 0 {
                if let covered = session.stitchedLines(in: position.range) {
                    rows.formUnion(covered)
                }
            }
            if session.selectedLines != rows { session.selectedLines = rows }
        }
    }

}

/// The old side of a split diff, beside the editor.
///
/// Owned by the session for the same reason the gutter's closures and the overlay are: it
/// must be the same view across SwiftUI passes, and it reads the editor's layout manager.
private struct OldSideColumnHost: NSViewRepresentable {
    @ObservedObject var session: WorkbenchSession

    func makeNSView(context: Context) -> OldSideColumnView { OldSideColumnView() }

    func updateNSView(_ view: OldSideColumnView, context: Context) {
        view.rowCount = session.gutterRowCount
        view.rowHeight = WorkbenchMetrics.rowHeight
        view.maxLineNumber = max(session.maxOldLineNumber, session.maxNewLineNumber)
        view.scrollViewProvider = { [weak session] in session?.editorScrollViewProvider?() }
        view.lineMetrics = { [weak session] index in session?.editorLineMetrics?(index) }
        view.lineIndex = { [weak session] y in session?.editorLineIndex?(y) }
        view.blockHeightAbove = { [weak session] index in
            session?.blockMap.height(beforeStitchedLine: index) ?? 0
        }
        view.row = { [weak session] index in session?.sideRow(index) }
        view.bandLines = { [weak session] block in session?.deletedLineRows(for: block) ?? [] }
        view.blocksAbove = { [weak session] index in
            session?.blockMap.blocks(beforeStitchedLine: index) ?? []
        }
        view.observeScroll()
        view.needsDisplay = true
    }
}

/// Bridges the band-control layer into SwiftUI, over the editor.
///
/// A representable rather than a hand-parented subview so SwiftUI owns the view's lifetime
/// and re-runs `updateNSView` on every pass — including the one after a rebuild replaces the
/// editor. The view itself lives on the session (like the highlighter and the renderer) so
/// it is the *same* view across those passes.
private struct WorkbenchOverlayHost: NSViewRepresentable {
    @ObservedObject var session: WorkbenchSession

    func makeNSView(context: Context) -> WorkbenchOverlayView { session.overlay }

    func updateNSView(_ view: WorkbenchOverlayView, context: Context) {
        view.scrollViewProvider = { [weak session] in session?.editorScrollViewProvider?() }
        session.refreshOverlay()
    }
}

/// Bridges `DiffGutterView` into SwiftUI.
///
/// Hands over the session, the scroll offset, and the row height — not a materialized
/// row array. Building 32k `GutterRow`s per scroll tick was pure waste; the view now
/// pulls only the rows it is about to draw.
private struct WorkbenchGutter: NSViewRepresentable {
    @ObservedObject var session: WorkbenchSession

    func makeNSView(context: Context) -> DiffGutterView { DiffGutterView() }

    func updateNSView(_ view: DiffGutterView, context: Context) {
        view.rowHeight = WorkbenchMetrics.rowHeight
        view.rowCount = session.gutterRowCount
        // A materialized array here, unlike the rows: it is one small value per row, only
        // exists when the buffer is narrowed to a single file, and the lane's width depends on
        // whether it is empty — which a closure could not answer without calling it.
        view.blameRows = session.blameRows
        // The same row the status strip is reporting, so the two cannot disagree about which
        // line the blame belongs to.
        view.blameSelectedRow = session.blameSelectedRow
        // Resolved through the session on every attempt, never snapshotted: on the pass
        // that mounts the editor this gutter updates *first*, so the provider isn't set
        // yet — and `load()` publishes everything in one runloop turn, so SwiftUI
        // coalesces it into a single pass and there is no second update to catch it.
        // The editor pushes `requestGutterAttach` once its scroll view exists.
        view.scrollViewProvider = { [weak session] in session?.editorScrollViewProvider?() }
        view.lineMetrics = { [weak session] index in session?.editorLineMetrics?(index) }
        view.lineIndex = { [weak session] documentY in session?.editorLineIndex?(documentY) }
        view.blockHeightAbove = { [weak session] index in
            session?.blockMap.height(beforeStitchedLine: index) ?? 0
        }
        view.blocksAbove = { [weak session] index in
            session?.blockMap.blocks(beforeStitchedLine: index) ?? []
        }
        view.onExpandGap = { [weak session] source, collapsed, fromTop in
            guard let session else { return }
            session.reveal(collapsed, inFile: session.relativePath(of: source), fromTop: fromTop)
        }
        view.onHoverBlameRow = { [weak session] row in session?.hoveredBlameRow = row }
        view.onClickBlame = { [weak session] row in
            guard let session, session.blameRows.indices.contains(row),
                  let cell = session.blameRows[row] else { return }
            session.revealCommit(sha: cell.sha)
        }
        session.requestGutterAttach = { [weak view] in view?.attachIfNeeded() }
        view.attachIfNeeded()
        view.row = { [weak session] idx in
            guard let session, idx < session.gutterRowCount else { return nil }
            // The trailing empty line past the last text row. It hosts a band that trails
            // the document, so it must report a row — but it shows nothing of its own.
            guard idx < session.rowOrigins.count else {
                return GutterRow(lineNumber: nil, sign: nil, tint: .none)
            }
            let origin = session.rowOrigins[idx]
            return GutterRow(
                // One number. Every row is a new-side line now, so the old number only
                // shows where there is no new one — which the sign column disambiguates.
                lineNumber: origin.newLineNumber ?? origin.oldLineNumber,
                sign: WorkbenchSession.sign(for: origin.kind),
                tint: session.style(atStitchedLine: idx).tint
            )
        }
        view.maxLineNumber = max(session.maxOldLineNumber, session.maxNewLineNumber)
        view.onSelectRows = { [weak session] rows in session?.setSelectedRows?(rows) }
        view.needsDisplay = true
        // The overlay tracks the same geometry as the gutter, so it is refreshed on the
        // same pass rather than through a second observer that could fall out of step.
        session.refreshOverlay()
    }
}

/// The workbench editor's theme, built from Shepherd's own palette — the same tokens
/// the diff rows and the gutter read, so nothing can drift between them.
///
/// Cached against the theme mode: it was a computed global, so every SwiftUI body
/// evaluation allocated fourteen `NSColor`s to build a value whose only use is an
/// equality check in `SourceEditor.paramsAreEqual`.
enum WorkbenchEditorTheme {
    private static var cached: (mode: ThemeMode, theme: EditorTheme)?

    static var current: EditorTheme {
        if let cached, cached.mode == Theme.mode { return cached.theme }
        let theme = makeWorkbenchEditorTheme()
        cached = (Theme.mode, theme)
        return theme
    }
}

private func makeWorkbenchEditorTheme() -> EditorTheme {
    func attr(_ hex: UInt32) -> EditorTheme.Attribute { .init(color: NSColor(hex24: hex)) }
    return EditorTheme(
        text: attr(Theme.Code.text),
        insertionPoint: NSColor(hex24: Theme.Code.keyword),
        invisibles: attr(Theme.Diff.gutterFg),
        background: NSColor(hex24: Theme.Diff.buffer),
        lineHighlight: NSColor(hex24: Theme.Diff.hover),
        selection: NSColor(hex24: Theme.Diff.modified).withAlphaComponent(0.25),
        keywords: attr(Theme.Code.keyword),
        commands: attr(Theme.Code.function),
        types: attr(Theme.Code.type),
        attributes: attr(Theme.Code.type),
        variables: attr(Theme.Code.variable),
        values: attr(Theme.Code.number),
        numbers: attr(Theme.Code.number),
        strings: attr(Theme.Code.string),
        characters: attr(Theme.Code.string),
        comments: attr(Theme.Code.comment)
    )
}
