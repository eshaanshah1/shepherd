import SwiftUI

/// A PR's inline review threads, as a right-hand inspector column beside the editor.
///
/// A column rather than cards anchored under their lines: overlay anchoring via
/// `rectsFor(range:)` during scroll is still unbuilt (`WidgetLayer`, deferred), and the
/// rail is too narrow for a threaded conversation. Clicking a thread jumps the editor to
/// its line, which is what an anchored card would have given.
///
/// Violet + octocat throughout, deliberately unlike the blue local comment bubbles: one
/// is a colleague's words on GitHub, the other is a note you are about to hand an agent.
struct WorkbenchThreadsPanel: View {
    @EnvironmentObject var store: AgentStore
    @ObservedObject var session: WorkbenchSession

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.hairline).frame(height: 1)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(groups, id: \.path) { group in
                        fileGroup(group)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Theme.surface1)
    }

    private var header: some View {
        HStack(spacing: 6) {
            TablerIcon(paths: Tabler.brandGithub, size: 12).foregroundStyle(Theme.prMerged)
            Text("REVIEW THREADS").font(.ui(9.5, .semibold)).foregroundStyle(Theme.textDim)
            Spacer(minLength: 0)
            GhostIconButton(systemName: "xmark", help: "Hide threads") {
                session.threadsPanelOpen = false
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    // MARK: - Grouping

    /// Threads for the pane, anchored ones first, split per file. Only in vs-base mode:
    /// they anchor to the PR's diff, and a working-tree diff has nothing to anchor to.
    private var threads: [GHReviewThread] {
        guard session.mode == .branchVsBase else { return [] }
        return store.reviewThreads[session.paneID] ?? []
    }

    private struct Group {
        let path: String
        let anchored: [(thread: GHReviewThread, stitchedLine: Int)]
        let unanchored: [GHReviewThread]
    }

    private var groups: [Group] {
        var order: [String] = []
        var byPath: [String: [GHReviewThread]] = [:]
        for thread in threads {
            if byPath[thread.path] == nil { order.append(thread.path) }
            byPath[thread.path, default: []].append(thread)
        }
        return order.map { path in
            var anchored: [(GHReviewThread, Int)] = []
            var unanchored: [GHReviewThread] = []
            for thread in byPath[path] ?? [] {
                if let line = thread.line,
                   let row = session.stitchedLine(forFile: path, line: line, side: thread.side) {
                    anchored.append((thread, row))
                } else {
                    unanchored.append(thread)
                }
            }
            return Group(path: path, anchored: anchored, unanchored: unanchored)
        }
    }

    @ViewBuilder private func fileGroup(_ group: Group) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text((group.path as NSString).lastPathComponent)
                .font(.ui(11, .semibold)).foregroundStyle(Theme.textSecondary)
                .help(group.path)

            ForEach(group.anchored, id: \.thread.id) { entry in
                ThreadCard(thread: entry.thread, file: group.path, session: session,
                           jump: { session.requestScroll(toStitchedLine: entry.stitchedLine) })
            }

            if !group.unanchored.isEmpty {
                UnanchoredThreads(threads: group.unanchored, file: group.path, session: session)
            }
        }
    }
}

/// Threads whose line no longer maps to the current diff — collapsed by default, so an
/// outdated conversation is reachable without crowding the live ones.
private struct UnanchoredThreads: View {
    let threads: [GHReviewThread]
    let file: String
    @ObservedObject var session: WorkbenchSession
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(threads) { thread in
                    ThreadCard(thread: thread, file: file, session: session, jump: nil)
                }
            }
            .padding(.top, 6)
        } label: {
            Text("\(threads.count) not on the current diff")
                .font(.ui(10, .medium)).foregroundStyle(Theme.textDim)
        }
        .tint(Theme.textDim)
    }
}

/// One thread: violet rail, octocat header, stacked replies, then Reply / Resolve /
/// Send-to-agent.
private struct ThreadCard: View {
    let thread: GHReviewThread
    let file: String
    @ObservedObject var session: WorkbenchSession
    /// nil ⇒ the thread doesn't map to a visible row, so there is nowhere to jump.
    let jump: (() -> Void)?
    @EnvironmentObject var store: AgentStore

    private var expanded: Bool {
        !thread.isResolved || session.expandedResolvedThreads.contains(thread.id)
    }
    private var visibleComments: [GHReviewComment] {
        expanded ? thread.comments : Array(thread.comments.prefix(1))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(Theme.prMerged.opacity(0.6)).frame(width: 3)
            VStack(alignment: .leading, spacing: 8) {
                headerRow
                ForEach(visibleComments) { comment in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("@\(comment.author.isEmpty ? "unknown" : comment.author)")
                                .font(.ui(11, .semibold)).foregroundStyle(Theme.textPrimary)
                            Text(Self.relative(comment.createdAt))
                                .font(.ui(10)).foregroundStyle(Theme.textDim)
                        }
                        Text(comment.body).font(.ui(12)).foregroundStyle(Theme.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
                if session.replyingToThread == thread.id {
                    ThreadReplyComposer(thread: thread, session: session)
                } else {
                    footer
                }
            }
            .opacity(thread.isResolved && !expanded ? 0.55 : 1)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .shepherdCard()
    }

    private var headerRow: some View {
        HStack(spacing: 6) {
            TablerIcon(paths: Tabler.brandGithub, size: 12).foregroundStyle(Theme.prMerged)
            if let line = thread.line {
                Button { jump?() } label: {
                    Text("line \(line)").font(.mono(10, .medium))
                        .foregroundStyle(jump == nil ? Theme.textDim : Theme.prMerged)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false).disabled(jump == nil)
                .help(jump == nil ? "Not on the current diff" : "Jump to this line")
            }
            if thread.isResolved {
                Text("Resolved").font(.ui(10, .medium)).foregroundStyle(Theme.textDim)
            }
            Spacer(minLength: 0)
            if thread.isResolved {
                Button { session.toggleExpandedResolved(thread.id) } label: {
                    Text(expanded ? "Hide" : "Show")
                        .font(.ui(10, .medium)).foregroundStyle(Theme.textDim)
                }
                .buttonStyle(.plain).focusable(false)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            action("Reply") { session.replyingToThread = thread.id }
            action(thread.isResolved ? "Reopen" : "Resolve") {
                store.setThreadResolved(id: thread.id, !thread.isResolved, forPane: session.paneID)
            }
            action("Send to agent") {
                guard let root = thread.comments.first else { return }
                session.addGitHubComment(file: file, line: thread.line ?? 0, side: thread.side,
                                         author: root.author, body: root.body)
            }
            Spacer(minLength: 0)
        }
    }

    private func action(_ title: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.ui(11, .semibold)).foregroundStyle(Theme.prMerged)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
    }

    /// Compact relative time from an ISO8601 timestamp; falls back to the raw string.
    static func relative(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

/// Inline reply composer — mirrors `CommentComposer`'s look, posts via the store, and
/// closes on send or cancel.
private struct ThreadReplyComposer: View {
    let thread: GHReviewThread
    @ObservedObject var session: WorkbenchSession
    @EnvironmentObject var store: AgentStore
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
                Spacer(minLength: 0)
                Button { session.replyingToThread = nil } label: {
                    Text("Cancel").font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 3).contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                Button {
                    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !body.isEmpty {
                        store.replyToThread(id: thread.id, body: body, forPane: session.paneID)
                    }
                    session.replyingToThread = nil
                } label: {
                    Text("Reply").font(.ui(11, .semibold))
                        .foregroundStyle(empty ? Theme.textDim : Theme.textPrimary)
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(empty ? Color.clear : Theme.surface3)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(empty).focusable(false)
            }
        }
        .onAppear { focused = true }
    }
}
