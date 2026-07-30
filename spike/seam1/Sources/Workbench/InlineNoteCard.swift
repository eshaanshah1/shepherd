import SwiftUI
import AppKit

/// One comment inside an inline note.
struct InlineNoteComment: Equatable, Hashable, Identifiable {
    let id: String
    let author: String
    /// ISO8601 as GitHub returned it; formatted at render time.
    let createdAt: String
    let body: String
}

/// A review note as the card under a diff line shows it — a local note bound for the agent,
/// or a GitHub thread with its whole reply chain.
///
/// A value, not a reference into `threads`/`comments`, so the same description drives the
/// card, its measured height and the height cache's key. Two of those disagreeing is a card
/// clipped by its own band.
struct InlineNote: Equatable, Hashable, Identifiable {
    let id: String
    let origin: ReviewNoteOrigin
    /// A live GitHub thread — repliable and resolvable. False for a local note, **including**
    /// one carrying a GitHub author: "Send to agent" copies somebody's comment into the
    /// outgoing batch, and that copy's id is a local UUID, so offering Reply on it would
    /// address a thread that does not exist.
    let isThread: Bool
    let file: String
    let line: Int
    /// false ⇒ the thread's line is no longer in the diff, so the card sits at the head of
    /// its file instead of under a line it is about, and says so.
    let anchored: Bool
    let isResolved: Bool
    let isOutdated: Bool
    let comments: [InlineNoteComment]

    var root: InlineNoteComment? { comments.first }
    var replyCount: Int { max(0, comments.count - 1) }

    /// First line of prose, markdown syntax resolved — what a collapsed card shows.
    var preview: String {
        guard let body = root?.body else { return "" }
        for block in MarkdownBlock.parse(body) {
            if case .paragraph(let text) = block {
                let plain = String(text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if !plain.isEmpty { return plain }
            }
        }
        return body.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Unsent replies, by thread id.
///
/// Deliberately not part of `WorkbenchSession`'s published state: the composer writes on every
/// keystroke, and the session is observed by the entire workbench.
final class ReplyDraftStore: ObservableObject {
    @Published var drafts: [String: String] = [:]

    func binding(for id: String) -> Binding<String> {
        Binding(get: { self.drafts[id] ?? "" }, set: { self.drafts[id] = $0 })
    }
}

/// Geometry the card and the band it sits in must agree on.
///
/// The band's height is measured from the card at exactly this width, so both sides read it
/// from here — a card laid out at a width it was not measured at is one clipped by its own
/// reserved space.
enum InlineNoteMetrics {
    /// Wide enough for prose, narrower than a diff. The document is as wide as its longest
    /// line, which on a diff is far past readable.
    static let maxWidth: CGFloat = 680
    static let insetX: CGFloat = 10
    static let insetY: CGFloat = 4

    /// Card width for a viewport, so a narrow pane shrinks the card rather than clipping it.
    static func width(available: CGFloat) -> CGFloat {
        guard available > 0 else { return maxWidth }
        return max(260, min(maxWidth, available - insetX * 2))
    }
}

/// A review note under the line it is about: rendered markdown, the reply chain, and real
/// controls.
///
/// Hosted as a live SwiftUI view over the editor rather than drawn into the band. Drawn, it
/// showed raw markdown source at a size nobody wanted to read and its actions were painted
/// chips in a second view; the reply it offered could only open a side panel, which is what
/// made that panel look load-bearing. The markdown renderer, the composer and the thread
/// chain already existed — this puts them where the comment is.
///
/// Reads the session so the card updates itself: expanding a resolved thread or opening the
/// composer is published state, and the band's height is re-measured from the same state.
struct InlineNoteCard: View {
    @ObservedObject var session: WorkbenchSession
    /// Observed separately so typing a reply re-renders this card and nothing else.
    @ObservedObject var drafts: ReplyDraftStore
    let noteID: String
    /// Fixed, and the same width the height was measured at.
    let width: CGFloat

    @FocusState private var composerFocused: Bool

    private var note: InlineNote? { session.inlineNote(id: noteID) }

    var body: some View {
        if let note {
            content(note)
                .frame(width: width, alignment: .leading)
        }
    }

    private func content(_ note: InlineNote) -> some View {
        let accent = Self.accent(note.origin)
        return VStack(alignment: .leading, spacing: 9) {
            header(note, accent: accent)
            if collapsed(note) {
                Text(note.preview)
                    .font(.ui(12)).foregroundStyle(Theme.textSecondary)
                    .lineLimit(1).truncationMode(.tail)
            } else {
                ForEach(Array(note.comments.enumerated()), id: \.element.id) { index, comment in
                    if index > 0 {
                        Rectangle().fill(accent.opacity(0.18)).frame(height: 1)
                    }
                    commentBody(comment, showAuthor: index > 0)
                }
                if session.replyingToThread == note.id {
                    composer(note)
                } else {
                    actions(note, accent: accent)
                }
            }
        }
        .padding(.horizontal, 13).padding(.vertical, 11)
        // The border goes all the way around: the card is a thing sitting on the diff, and a
        // left rail alone left its bottom edge dissolving into whichever row followed it.
        .background {
            let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)
            ZStack {
                // Opaque first: the band is a hole in the document, and the diff rows the
                // card overlaps would otherwise read straight through it.
                shape.fill(Color(hex: Theme.Diff.buffer))
                shape.fill(accent.opacity(0.09))
                shape.strokeBorder(accent.opacity(0.42), lineWidth: 1)
            }
        }
    }

    /// A resolved thread stays folded to one line until asked for — it is settled, and the
    /// live ones are what the diff is for.
    private func collapsed(_ note: InlineNote) -> Bool {
        note.isResolved && !session.expandedResolvedThreads.contains(note.id)
    }

    // MARK: - Header

    private func header(_ note: InlineNote, accent: Color) -> some View {
        HStack(spacing: 7) {
            // Told apart three ways, not by colour alone — these two are a blue and a
            // violet, which is the pair ~8% of men cannot separate.
            if note.origin == .github {
                TablerIcon(paths: Tabler.brandGithub, size: 12).foregroundStyle(accent)
            } else {
                RoundedRectangle(cornerRadius: 2).fill(accent).frame(width: 8, height: 8)
            }
            Text(authorLabel(note))
                .font(.ui(12, .semibold)).foregroundStyle(Theme.textPrimary)
            if let created = note.root?.createdAt, !created.isEmpty {
                Text(Self.relative(created))
                    .font(.ui(10.5)).foregroundStyle(Theme.textDim)
            }
            if note.replyCount > 0, collapsed(note) {
                Text("· \(note.replyCount) repl\(note.replyCount == 1 ? "y" : "ies")")
                    .font(.ui(10.5)).foregroundStyle(Theme.textDim)
            }
            Spacer(minLength: 6)
            badges(note, accent: accent)
        }
    }

    /// Whose words these are — a local note of your own says so, and one you copied out of a
    /// review keeps its author's handle.
    private func authorLabel(_ note: InlineNote) -> String {
        if let author = note.root?.author, !author.isEmpty { return "@\(author)" }
        return "You"
    }

    @ViewBuilder private func badges(_ note: InlineNote, accent: Color) -> some View {
        if !note.isThread, note.origin == .github {
            badge("queued for agent", tint: accent)
        }
        if !note.anchored {
            badge("not on this diff", tint: Theme.textDim)
                .help("The line this thread was left on isn't in the current diff, so it "
                      + "sits at the top of its file.")
        }
        if note.isOutdated, note.anchored {
            badge("outdated", tint: Theme.textDim)
        }
        Text("\((note.file as NSString).lastPathComponent):\(note.line)")
            .font(.mono(10.5)).foregroundStyle(Theme.textDim)
            .help(note.file)
        if note.isResolved {
            Button { session.toggleExpandedResolved(note.id) } label: {
                Text(collapsed(note) ? "Show" : "Hide")
                    .font(.ui(10.5, .semibold)).foregroundStyle(accent)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
        }
    }

    private func badge(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.ui(9.5, .medium)).foregroundStyle(tint)
            .padding(.horizontal, 5).padding(.vertical, 1.5)
            .background(tint.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }

    // MARK: - Body

    private func commentBody(_ comment: InlineNoteComment, showAuthor: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if showAuthor {
                HStack(spacing: 6) {
                    Text("@\(comment.author.isEmpty ? "unknown" : comment.author)")
                        .font(.ui(11.5, .semibold)).foregroundStyle(Theme.textSecondary)
                    Text(Self.relative(comment.createdAt))
                        .font(.ui(10)).foregroundStyle(Theme.textDim)
                }
            }
            // Rendered, not raw. A review comment is markdown — fences, lists, inline code —
            // and its source is the worst version of it.
            MarkdownText(source: comment.body, font: 12.5, wrapsCode: true, blockSpacing: 8)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Controls

    private func actions(_ note: InlineNote, accent: Color) -> some View {
        HStack(spacing: 7) {
            if note.isThread {
                button("Reply", accent: accent) { session.beginReply(to: note.id) }
                button(note.isResolved ? "Reopen" : "Resolve", accent: accent) {
                    session.requestThreadResolved(note.id, !note.isResolved)
                }
                button("Send to agent", accent: accent) { session.sendNoteToAgent(note.id) }
            } else {
                button("Remove", accent: accent) { session.removeInlineNote(note.id) }
            }
            Spacer(minLength: 0)
        }
    }

    private func button(_ title: String, accent: Color,
                        action: @escaping () -> Void) -> some View {
        NoteActionButton(title: title, accent: accent, action: action)
    }

    @ViewBuilder private func composer(_ note: InlineNote) -> some View {
        let draft = drafts.binding(for: note.id)
        let empty = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: draft)
                    .font(.ui(12)).scrollContentBackground(.hidden)
                    .focused($composerFocused)
                    .frame(height: 62)
                if empty {
                    Text("Reply on GitHub…").font(.ui(12)).foregroundStyle(Theme.textDim)
                        .padding(.leading, 5).padding(.top, 1).allowsHitTesting(false)
                }
            }
            .padding(6)
            .background(Color(hex: Theme.Diff.buffer))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay {
                RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.hairline, lineWidth: 1)
            }
            HStack(spacing: 7) {
                NoteActionButton(title: "Reply", accent: Self.accent(note.origin),
                                 filled: true, disabled: empty) {
                    session.postReply(to: note.id,
                                      body: draft.wrappedValue
                                        .trimmingCharacters(in: .whitespacesAndNewlines))
                }
                NoteActionButton(title: "Cancel", accent: Theme.textDim) {
                    session.cancelReply()
                }
                Spacer(minLength: 0)
            }
        }
        .onAppear { composerFocused = true }
        .onExitCommand { session.cancelReply() }
    }

    // MARK: - Shared

    static func accent(_ origin: ReviewNoteOrigin) -> Color {
        origin == .mine
            ? Color(hex: Theme.Diff.modified)   // blue — bound for the agent
            : Color(hex: 0xA371F7)              // violet — somebody else's review
    }

    /// Compact relative time from an ISO8601 timestamp; falls back to the raw string.
    static func relative(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

/// A card control that reads as a button: filled, bordered, and big enough to hit.
///
/// The drawn chips this replaces were 15pt tall with a 10pt label and no border, which read
/// as annotations on the card rather than as things to press.
private struct NoteActionButton: View {
    let title: String
    let accent: Color
    var filled = false
    var disabled = false
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.ui(11.5, .semibold))
                .foregroundStyle(foreground)
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background {
                    let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
                    ZStack {
                        shape.fill(background)
                        shape.strokeBorder(accent.opacity(disabled ? 0.16 : 0.45), lineWidth: 1)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(disabled)
        .onHover { hovering = $0 && !disabled }
    }

    private var foreground: Color {
        if disabled { return Theme.textDim }
        return filled ? Color(hex: Theme.Diff.buffer) : accent
    }

    private var background: Color {
        if disabled { return .clear }
        if filled { return accent.opacity(hovering ? 1 : 0.85) }
        return accent.opacity(hovering ? 0.28 : 0.14)
    }
}

/// A card mounted over the editor.
///
/// Forwards the scroll wheel to the editor's scroll view. A hosted view is the one thing in
/// this layer that can *consume* an event, and a card that swallows the wheel is a dead patch
/// in the middle of a scrollable document — which is also why the card's code blocks wrap
/// instead of scrolling.
final class InlineNoteCardHostView: NSHostingView<AnyView> {
    var forwardScroll: ((NSEvent) -> Void)?

    override func scrollWheel(with event: NSEvent) {
        guard let forwardScroll else { return super.scrollWheel(with: event) }
        forwardScroll(event)
    }
}

// MARK: - Session bridge

@MainActor
extension WorkbenchSession {
    /// The note behind a band, by id.
    func inlineNote(id: String) -> InlineNote? { inlineNotes.first { $0.id == id } }

    /// A mounted card for a band, at the width its height was measured at.
    func inlineNoteCardView(id: String, width: CGFloat) -> NSView? {
        guard inlineNote(id: id) != nil else { return nil }
        let host = InlineNoteCardHostView(
            rootView: AnyView(InlineNoteCard(session: self, drafts: replyDrafts,
                                             noteID: id, width: width)))
        host.forwardScroll = { [weak self] event in
            self?.editorScrollViewProvider?()?.scrollWheel(with: event)
        }
        return host
    }

    /// Height the band must reserve, measured off the card itself.
    ///
    /// Measured rather than arithmetic on the raw text: the card renders markdown, so its
    /// height depends on fences, lists and the reply chain, and the string-measuring version
    /// of this was wrong for every comment that used any of them.
    func inlineNoteHeight(_ note: InlineNote, width: CGFloat) -> CGFloat {
        let key = NoteHeightKey(note: note, width: width,
                               expanded: expandedResolvedThreads.contains(note.id),
                               replying: replyingToThread == note.id)
        if let hit = noteHeightCache[key] { return hit }
        let host = NSHostingView(
            rootView: AnyView(InlineNoteCard(session: self, drafts: replyDrafts,
                                             noteID: note.id, width: width)))
        host.frame.size = NSSize(width: width, height: 1)
        host.layoutSubtreeIfNeeded()
        let height = ceil(host.fittingSize.height) + InlineNoteMetrics.insetY * 2
        // A card that resolved no note measures as nothing. `placeNotes` is ordered so this
        // cannot happen; not caching it means a single mistake costs one bad frame instead of
        // a band that stays collapsed for as long as the pane is open.
        guard height > InlineNoteMetrics.insetY * 2 else { return height }
        if noteHeightCache.count > 256 { noteHeightCache.removeAll() }
        noteHeightCache[key] = height
        return height
    }
}

/// What a measured card height depends on. Anything absent from this key is something the
/// card may not render differently — a stale height is a clipped card.
struct NoteHeightKey: Hashable {
    let note: InlineNote
    let width: CGFloat
    let expanded: Bool
    let replying: Bool
}
