import AppKit

/// One clickable control on a band.
struct OverlayTarget: Equatable {
    let conflictID: String
    let resolution: Resolution
    let title: String
    let rect: NSRect
    /// The choice already taken. Nil resolution on the block means undecided, and then
    /// nothing is active — the document previews ours, but that is not a decision.
    let isActive: Bool
}

/// A transparent layer over the text view that draws and hit-tests band controls.
///
/// It exists because `TextView.hitTest` returns the text view for **any** point inside it,
/// so a line-fragment subview never receives a click. The hunk-gap arrows solved that by
/// moving into the gutter and the reconcile actions by moving into the rail; neither works
/// for four labelled buttons, so this is the third answer — and the one the deferred
/// `WidgetLayer` wants, which is why it is written against "blocks with targets" rather than
/// against conflicts specifically.
///
/// It obeys the rules the gutter cost two days to learn:
///
/// - Scroll comes from the clip view's `boundsDidChangeNotification`, **never**
///   `SourceEditorState.scrollPosition`, which lands a run-loop pass late and slides the
///   overlay against the text.
/// - Row geometry comes from the editor's layout manager via `lineMetrics`. There is exactly
///   one opinion about where a line sits, shared with the gutter and the band renderer.
/// - **SwiftUI owns its lifetime**, mounted beside the editor rather than parented into the
///   scroll view by hand. Hand-parenting meant every rebuild — which is exactly what
///   resolving a conflict causes, via `.id(session.revision)` — left it inside a scroll view
///   nobody displays, and the bands vanished from the entire document.
/// - `clipsToBounds = true`. It defaults to false since macOS 14, and rows are placed at
///   `yPos - scrollY`, so scrolled-past bands would paint over the chrome above.
/// - Controls are **drawn**, not hosted as `NSButton`s, so scrolling causes no view churn.
/// - `targets(...)` lays out once and both `draw` and `hitTest` read it, so what is painted
///   and what is clickable cannot drift.
final class WorkbenchOverlayView: NSView {
    /// Blocks sitting immediately above a row.
    var blocksAbove: ((Int) -> [Block])?
    /// Real geometry for a row, from the editor's layout manager.
    var lineMetrics: ((Int) -> (yPos: CGFloat, height: CGFloat)?)?
    /// Row index at a document y.
    var lineIndex: ((CGFloat) -> Int?)?
    var rowCount = 0
    var rowHeight: CGFloat = 16
    var onResolve: ((String, Resolution) -> Void)?

    /// The scroll view the editor built, resolved live.
    var scrollViewProvider: (() -> NSScrollView?)?

    /// Read from the clip view on demand, never cached.
    ///
    /// A stored copy is only as fresh as the last notification that updated it, and one
    /// missed notification — a clip view swapped by a re-tile, an attach that landed after
    /// the scroll — leaves every band positioned as though the document were at the top,
    /// which puts all of them off screen. The notification now only triggers a redraw; it
    /// is not the source of truth for where anything is.
    private var scrollY: CGFloat { scrollViewProvider?()?.contentView.bounds.origin.y ?? 0 }

    private weak var observedClipView: NSClipView?
    private var hovered: OverlayTarget?
    private var trackingAreaInstalled: NSTrackingArea?

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        clipsToBounds = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        clipsToBounds = true
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: - Scroll

    /// Observe the editor's scroll so a scroll repaints the bands.
    ///
    /// **Only** a repaint trigger. Where a band sits is read from the clip view live (see
    /// `scrollY`), so a missed notification costs a stale frame, never a wrong position.
    ///
    /// This view is no longer parented into the scroll view by hand. It was, and every
    /// rebuild — which is what resolving a conflict causes — replaced the editor via
    /// `.id(session.revision)`, leaving the overlay attached to a scroll view nobody
    /// displays; the bands then vanished from the whole document. SwiftUI owns its lifetime
    /// now, and this only has to find the clip view to listen to.
    func observeScroll() {
        guard let clipView = scrollViewProvider?()?.contentView,
              clipView !== observedClipView else { return }
        if let observedClipView {
            NotificationCenter.default.removeObserver(
                self, name: NSView.boundsDidChangeNotification, object: observedClipView)
        }
        clipView.postsBoundsChangedNotifications = true
        observedClipView = clipView
        NotificationCenter.default.addObserver(
            self, selector: #selector(clipViewDidScroll(_:)),
            name: NSView.boundsDidChangeNotification, object: clipView)
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
    }

    @objc private func clipViewDidScroll(_ notification: Notification) {
        // A control under the pointer can scroll out from under it.
        if hovered != nil { hovered = nil }
        needsDisplay = true
        // Cursor rects are in view coordinates, so scrolling invalidates every one of them.
        window?.invalidateCursorRects(for: self)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaInstalled { removeTrackingArea(trackingAreaInstalled) }
        let area = NSTrackingArea(rect: bounds,
                                  options: [.mouseMoved, .mouseEnteredAndExited,
                                            .activeInKeyWindow, .inVisibleRect],
                                  owner: self)
        addTrackingArea(area)
        trackingAreaInstalled = area
    }

    // MARK: - Layout

    /// The control bands the document holds, with the row each sits above.
    ///
    /// Supplied whole rather than discovered by walking rows. The row walk it replaced
    /// estimated its window from `rowHeight`, which is the *text's* line height — but a
    /// controls band is twice that and a conflict's rows sit between two of them, so the
    /// estimate overshot and skipped bands that were on screen. It also depended on the
    /// layout manager being ready, which it briefly is not right after a rebuild remounts
    /// the editor — which is precisely when a resolution happens. There are a handful of
    /// these per document; asking for them directly cannot miss one.
    var controlBands: (() -> [(block: Block, row: Int)])?

    /// Every control on screen, with the band it belongs to positioned from real geometry.
    private func visibleBands() -> [(kind: BlockKind, rect: NSRect)] {
        guard let metrics = lineMetrics else { return [] }
        var out: [(BlockKind, NSRect)] = []
        for (block, row) in controlBands?() ?? [] {
            guard let rowTop = metrics(row)?.yPos else { continue }
            // A row can host several bands; this one starts below whichever precede it.
            var y = rowTop - scrollY
            for above in blocksAbove?(row) ?? [] {
                if above.id == block.id { break }
                y += above.height
            }
            let band = NSRect(x: 0, y: y, width: bounds.width, height: block.height)
            guard band.intersects(bounds) else { continue }
            out.append((block.kind, band))
        }
        return out
    }

    private func visibleTargets() -> [OverlayTarget] {
        visibleBands().flatMap { Self.targets(for: $0.kind, in: $0.rect) }
    }

    private static let font = NSFont.systemFont(ofSize: 10, weight: .medium)
    /// The heading is a conflict marker, so it wears the code font the markers in a real
    /// file would — that is what makes it read as one.
    private static var headingFont: NSFont { WorkbenchMetrics.font }

    /// The controls for a band, laid out left to right after its label.
    ///
    /// Read by both `draw` and `hitTest`, so a button is clickable exactly where it is
    /// painted — the rule `DiffGutterView.expandTargets` set.
    static func targets(for kind: BlockKind, in band: NSRect) -> [OverlayTarget] {
        guard case .conflictControls(_, let conflictID, let index, let total,
                                     let resolution, let conflictKind,
                                     let oursLabel, let theirsLabel) = kind else { return [] }

        let ours = short(oursLabel)
        let theirs = short(theirsLabel)
        var choices: [(Resolution, String)] = [(.ours, ours), (.theirs, theirs)]
        // Interleaving a deletion or a binary blob means nothing, so those get two options.
        //
        // The keep-both buttons are named for the **order** they produce, because the only
        // thing separating them is which side lands first. They were "Both" and "Both ⇅",
        // where an arrow carried that entire meaning and told a reader nothing.
        if !conflictKind.isWholeFile {
            // Named for the order rather than by concatenating both branch names: two long
            // names side by side (`workbench-w3-merge-resolver+main`) is unreadable, and
            // these labels are a fixed width whatever the branches are called. Which branch
            // is "current" is legible from the two buttons to the left, which do carry names.
            choices += [(.bothOursFirst, "Both (current first)"),
                        (.bothTheirsFirst, "Both (incoming first)")]
        }

        let row = ConflictBandMetrics.controlsLayout(band).buttons
        var x: CGFloat = 10
        let height: CGFloat = 17
        let y = row.midY - height / 2

        return choices.map { resolution_, title in
            let width = (title as NSString)
                .size(withAttributes: [.font: font]).width + 16
            let rect = NSRect(x: x, y: y, width: width, height: height)
            x += width + 5
            return OverlayTarget(conflictID: conflictID, resolution: resolution_,
                                 title: title, rect: rect,
                                 isActive: resolution == resolution_)
        }
    }

    /// Branch names get long, and the keep-both buttons carry two of them.
    ///
    /// Trimmed from the **front**, keeping the tail: real branch names are prefixed
    /// (`feature/`, `eshaan/`, `workbench-w3-`) and it is the end that identifies them.
    private static func short(_ label: String, limit: Int = 14) -> String {
        guard label.count > limit else { return label }
        return "…" + String(label.suffix(limit - 1))
    }

    /// Which side's block this marker opens — it wears that side's colour, so the region
    /// below it reads as bounded rather than as one long tinted run.
    private static func leadingSide(of kind: BlockKind) -> MergeSide {
        guard case .conflictControls(_, _, _, _, let resolution, _, _, _) = kind else {
            return .ours
        }
        switch resolution {
        case .some(.theirs), .some(.bothTheirsFirst): return .theirs
        default:                                      return .ours
        }
    }

    /// The heading a band draws to the left of its controls.
    ///
    /// Git's own opening marker, `<<<<<<< main`, because that shape is one every developer
    /// can already read without being taught — even though nothing here was parsed from a
    /// marker; the sides come from a three-way merge of the index's stage blobs. Once a side
    /// is chosen the region is no longer split, so it says what was taken instead.
    private static func heading(for kind: BlockKind) -> String? {
        guard case .conflictControls(_, _, let index, let total, let resolution, let conflictKind,
                                     let oursLabel, let theirsLabel) = kind else { return nil }
        let counter = total > 1 ? " (\(index)/\(total))" : ""
        guard !conflictKind.isWholeFile else { return "CONFLICT\(counter)" }
        switch resolution {
        case .none, .some(.bothOursFirst):
            return "<<<<<<< \(oursLabel)\(counter)"
        case .some(.bothTheirsFirst):
            return "<<<<<<< \(theirsLabel)\(counter)"
        case .some(.ours):
            return "✓ \(oursLabel)\(counter)"
        case .some(.theirs):
            return "✓ \(theirsLabel)\(counter)"
        }
    }

    // MARK: - Draw

    /// Draws only. **Never** attaches.
    ///
    /// It used to attach here too, and `attachIfNeeded` could `removeFromSuperview()` —
    /// tearing a view out of the hierarchy part-way through its own draw pass, which is not
    /// survivable and was crashing the app.
    override func draw(_ dirtyRect: NSRect) {
        let bands = visibleBands()
        for band in bands where band.rect.intersects(dirtyRect) {
            drawBand(band.kind, in: band.rect)
        }
    }

    private func drawBand(_ kind: BlockKind, in band: NSRect) {
        let accent = NSColor(hex24: Self.leadingSide(of: kind) == .theirs
                             ? Theme.Diff.modified : Theme.Diff.addition)
        let layout = ConflictBandMetrics.controlsLayout(band)

        // The buttons row reads as chrome; the marker line reads as the file's own content,
        // so only the marker wears the side's tint.
        NSColor(hex24: Theme.Diff.buffer).setFill()
        layout.buttons.fill()
        accent.withAlphaComponent(0.22).setFill()
        layout.marker.fill()

        if let heading = Self.heading(for: kind) {
            let text = heading as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: Self.headingFont,
                .foregroundColor: accent,
            ]
            let size = text.size(withAttributes: attributes)
            text.draw(at: NSPoint(x: 0, y: layout.marker.midY - size.height / 2),
                      withAttributes: attributes)
        }

        for target in Self.targets(for: kind, in: band) {
            let path = NSBezierPath(roundedRect: target.rect, xRadius: 4, yRadius: 4)
            if target.isActive {
                accent.setFill()
                path.fill()
            } else {
                accent.withAlphaComponent(hovered == target ? 0.30 : 0.14).setFill()
                path.fill()
            }
            let text = target.title as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: Self.font,
                .foregroundColor: target.isActive
                    ? NSColor(hex24: Theme.Diff.buffer)
                    : NSColor(hex24: Theme.Code.text),
            ]
            let size = text.size(withAttributes: attributes)
            text.draw(at: NSPoint(x: target.rect.midX - size.width / 2,
                                  y: target.rect.midY - size.height / 2),
                      withAttributes: attributes)
        }
    }

    // MARK: - Mouse

    /// Transparent everywhere but its controls.
    ///
    /// Returning nil lets text selection, clicks, drags and the scroll wheel reach the text
    /// view underneath as though this layer were not here — which for all but a few dozen
    /// points of the window, it isn't.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard bounds.contains(local),
              visibleTargets().contains(where: { $0.rect.contains(local) }) else { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let target = visibleTargets().first(where: { $0.rect.contains(point) }) else {
            return
        }
        onResolve?(target.conflictID, target.resolution)
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let next = visibleTargets().first { $0.rect.contains(point) }
        guard next != hovered else { return }
        hovered = next
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        guard hovered != nil else { return }
        hovered = nil
        needsDisplay = true
    }
}
