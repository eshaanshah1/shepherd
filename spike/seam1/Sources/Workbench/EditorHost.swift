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

/// The workbench's text surface: our gutter beside CESE's editor over a shared storage.
///
/// Wrapping is off deliberately — a diff scrolls horizontally rather than reflowing, so
/// one stitched line is exactly one row. That invariant is what lets the gutter place
/// rows arithmetically from `WorkbenchMetrics.rowHeight` instead of querying layout for
/// every visible row on every scroll tick.
struct EditorHost: View {
    @ObservedObject var session: WorkbenchSession
    @State private var editorState = SourceEditorState()

    private var configuration: SourceEditorConfiguration {
        SourceEditorConfiguration(
            appearance: .init(
                theme: WorkbenchEditorTheme.current,
                font: WorkbenchMetrics.font,
                lineHeightMultiple: Theme.lineHeightMultiple,
                wrapLines: false
            ),
            // Read-only until W2's edit write-back lands. Nothing maps typed text back to
            // a `SourceBuffer`, so edits would not persist — and worse, `rowStyles` /
            // `gutterRows` / `rowOrigins` are indexed by stitched line, so one typed
            // newline shifts every row after it and silently corrupts the gutter numbers,
            // row tints, and staging targets. Selection is unaffected (`isSelectable`
            // defaults true), which is what line staging runs on.
            behavior: .init(isEditable: false),
            // Our own gutter replaces CESE's (which can't show dual line numbers), and
            // a minimap over a stitched multibuffer would map to nothing meaningful.
            peripherals: .init(showGutter: false, showMinimap: false, showFoldingRibbon: false)
        )
    }

    var body: some View {
        HStack(spacing: 0) {
            WorkbenchGutter(session: session)
                .frame(width: DiffGutterView.width(
                    maxLineNumber: max(session.maxOldLineNumber, session.maxNewLineNumber)))
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
                coordinators: [RenderDelegateInstaller(
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
                        // `prepareCoordinator` runs inside the controller's `init`;
                        // `loadView()` — which builds the scroll view — only happens once
                        // SwiftUI installs the controller's view, after this pass. One
                        // hop later it exists, so that is when the gutter can hook up.
                        DispatchQueue.main.async { [weak session] in
                            session?.requestGutterAttach?()
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
        view.rowCount = session.gutterRows.count
        // Resolved through the session on every attempt, never snapshotted: on the pass
        // that mounts the editor this gutter updates *first*, so the provider isn't set
        // yet — and `load()` publishes everything in one runloop turn, so SwiftUI
        // coalesces it into a single pass and there is no second update to catch it.
        // The editor pushes `requestGutterAttach` once its scroll view exists.
        view.scrollViewProvider = { [weak session] in session?.editorScrollViewProvider?() }
        view.lineMetrics = { [weak session] index in session?.editorLineMetrics?(index) }
        view.lineIndex = { [weak session] documentY in session?.editorLineIndex?(documentY) }
        view.blockHeightAbove = { [weak session] index in
            session?.blockMap.blocks(beforeStitchedLine: index).reduce(0) { $0 + $1.height } ?? 0
        }
        view.blocksAbove = { [weak session] index in
            session?.blockMap.blocks(beforeStitchedLine: index) ?? []
        }
        view.onExpandGap = { [weak session] source, collapsed, fromTop in
            guard let session else { return }
            session.reveal(collapsed, inFile: session.relativePath(of: source), fromTop: fromTop)
        }
        session.requestGutterAttach = { [weak view] in view?.attachIfNeeded() }
        view.attachIfNeeded()
        view.row = { [weak session] idx in
            guard let session, idx < session.gutterRows.count,
                  idx < session.rowOrigins.count else { return nil }
            let row = session.gutterRows[idx]
            return GutterRow(
                // One number: the new-side one, or the old on a removal. The sign column
                // says which side it is, so showing both only stutters on context lines.
                lineNumber: row.new ?? row.old,
                sign: WorkbenchSession.sign(for: session.rowOrigins[idx].kind),
                tint: session.style(atStitchedLine: idx).tint,
                selected: session.selectedLines.contains(idx)
            )
        }
        view.maxLineNumber = max(session.maxOldLineNumber, session.maxNewLineNumber)
        view.onSelectRows = { [weak session] rows in session?.setSelectedRows?(rows) }
        view.needsDisplay = true
    }
}

/// The workbench editor's theme, built from Shepherd's own palette — the same tokens
/// the diff rows and the gutter read, so nothing can drift between them.
///
/// Cached against the theme mode: it was a computed global, so every SwiftUI body
/// evaluation allocated fourteen `NSColor`s to build a value whose only use is an
/// equality check in `SourceEditor.paramsAreEqual`.
private enum WorkbenchEditorTheme {
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
