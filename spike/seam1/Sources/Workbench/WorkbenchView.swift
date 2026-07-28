import SwiftUI
import AppKit

/// The unified workbench: one rail (scope · files · commit) beside one editable text
/// surface. Replaces the old review panel and the separate code-surface editor, which
/// were mutually exclusive full-window overlays with different chrome.
struct WorkbenchView: View {
    @EnvironmentObject var store: AgentStore
    @ObservedObject var session: WorkbenchSession
    /// The line being commented on, resolved from the editor's cursor.
    @State private var composing: (file: String, line: Int, side: DiffSide)?
    @FocusState private var commitFocused: Bool
    /// Name for a new worktree, collected before handing off to the existing flow.
    @State private var worktreePrompt = false
    @State private var worktreeName = ""
    @State private var abortConfirm = false

    var body: some View {
        HStack(spacing: 0) {
            rail
                .frame(width: 260)
            Rectangle().fill(Theme.hairline).frame(width: 1)
            VStack(spacing: 0) {
                header
                Rectangle().fill(Theme.hairline).frame(height: 1)
                WorkbenchPRBand(session: session).environmentObject(store)
                content
            }
            if session.threadsPanelOpen, !paneThreads.isEmpty {
                Rectangle().fill(Theme.hairline).frame(width: 1)
                WorkbenchThreadsPanel(session: session)
                    .environmentObject(store)
                    .frame(width: 340)
            }
        }
        .background(Theme.ground)
        .overlay { composerOverlay }
        .overlay { if session.finderOpen { WorkbenchFinder(session: session) } }
        .alert("Abort \(abortVerb)?", isPresented: $abortConfirm) {
            Button("Abort \(abortVerb)", role: .destructive) { session.abortOperation() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Throws away every resolution and returns the repo to where it was before "
                 + "the \(abortVerb) started.")
        }
        .alert("New worktree", isPresented: $worktreePrompt) {
            TextField("Branch name", text: $worktreeName)
            Button("Create") { createWorktree() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Creates a worktree off origin's default branch and opens it in a new tab.")
        }
        .background { keyBindings }
        .onAppear {
            session.load()
            // Cheap on a clean repo — `ls-files -u` returns nothing for one process — and
            // it is the only way the Files segment can know it has conflicts to show.
            session.loadConflicts()
            // Once per open, not per glance at the header: the old `.onTapGesture` on the
            // Menu was also unreliable, since the menu consumes the tap.
            session.loadBranches()
            // The pane may never have gone idle (so the periodic PR sweep never ran),
            // and vs-base review is the reason to be here.
            store.refreshPR(forPane: session.paneID)
        }
        .onChange(of: session.mode) { _ in session.load() }
        // Landing on a diff while the repo is mid-merge buries the thing you have to deal
        // with; the conflicts are the reason the workbench is open.
        .onChange(of: session.hasConflicts) { hasConflicts in
            if hasConflicts, session.scope != .files { session.setScope(.files) }
        }
        // The store owns the threads; the session needs them to place the inline notes.
        .onChange(of: paneThreads) { session.threads = $0 }
        .onAppear { session.threads = paneThreads }
        // The store-backed half of a note's inline actions. The session owns the band layer
        // but not the store, so it hands these back up.
        .onAppear {
            session.onReviewAction = { action in
                switch action {
                case .setThreadResolved(let id, let resolved):
                    store.setThreadResolved(id: id, resolved, forPane: session.paneID)
                case .sendNoteToAgent(let id):
                    guard let thread = paneThreads.first(where: { $0.id == id }),
                          let root = thread.comments.first else { return }
                    session.addGitHubComment(file: thread.path, line: thread.line ?? 0,
                                             side: thread.side, author: root.author,
                                             body: root.body)
                default:
                    break
                }
            }
        }
        .onChange(of: store.diffTurnTick) { _ in
            if store.diffTurnPane == session.paneID { session.load() }
        }
    }

    // MARK: - Keys

    /// The workbench's own shortcuts, as zero-sized buttons.
    ///
    /// Deliberately *not* menu commands (see `ShortcutCatalog`): a menu key equivalent
    /// wins over the key window's responder chain, so binding ⌥↓ or ⌘⏎ in the menu bar
    /// would steal them from the terminal whenever the workbench is closed. Declared
    /// here, they exist exactly as long as this view does.
    @ViewBuilder private var keyBindings: some View {
        Group {
            key(.downArrow, [.option]) { moveToHunk(forward: true) }
            key(.upArrow, [.option]) { moveToHunk(forward: false) }
            key(.return, [.command]) { session.stageSelection() }
            key(.return, [.command, .option]) { session.unstageSelection() }
            key("k", [.command]) { commitFocused = true }
            key("p", [.command]) { session.openFinder() }   // no-ops while unmerged
            key("1", [.control]) { if session.isRepo { session.setScope(.workingTree) } }
            key("2", [.control]) { if session.isRepo { session.setScope(.vsBase) } }
            key("3", [.control]) { session.setScope(.files) }
            key("\\", [.command, .option]) {
                if session.splitAvailable { session.splitView.toggle() }
            }
            key("o", [.control, .shift]) { acceptAtCursor(.ours) }
            key("t", [.control, .shift]) { acceptAtCursor(.theirs) }
            key("b", [.control, .shift]) { acceptAtCursor(.bothOursFirst) }
        }
        .opacity(0).frame(width: 0, height: 0)
    }

    /// Take a side for the conflict the cursor is sitting in.
    private func acceptAtCursor(_ resolution: Resolution) {
        guard let line = session.cursorStitchedLine,
              session.rowOrigins.indices.contains(line),
              let id = session.rowOrigins[line].conflictID else { return }
        session.resolve(conflictID: id, as: resolution)
    }

    private func key(_ k: KeyEquivalent, _ mods: EventModifiers,
                    _ action: @escaping () -> Void) -> some View {
        Button("", action: action)
            .keyboardShortcut(k, modifiers: mods)
            .focusable(false)
    }

    /// Move the cursor to the next/previous hunk by selecting its first row, which is
    /// also what the gutter and the staging default read as "this hunk".
    private func moveToHunk(forward: Bool) {
        let origins = session.rowOrigins
        let target = forward
            ? StageSelection.hunkStart(after: session.cursorStitchedLine, origins: origins)
            : StageSelection.hunkStart(before: session.cursorStitchedLine, origins: origins)
        guard let target else { return }
        session.requestScroll(toStitchedLine: target)
    }

    // MARK: - Header

    /// The composer, over a click-to-dismiss backdrop. Esc cancels via `.cancelAction`.
    @ViewBuilder private var composerOverlay: some View {
        if let target = composing {
            ZStack {
                Color.black.opacity(0.35)
                    .contentShape(Rectangle())
                    .onTapGesture { composing = nil }
                CommentComposer(
                    file: target.file, line: target.line, side: target.side,
                    onSubmit: { text in
                        session.addComment(file: target.file, line: target.line,
                                           side: target.side, text: text)
                        composing = nil
                    },
                    onCancel: { composing = nil }
                )
                Button("") { composing = nil }
                    .keyboardShortcut(.cancelAction)
                    .opacity(0).frame(width: 0, height: 0).focusable(false)
            }
            .transition(.opacity)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            summary
            if let reason = session.editBlockedReason {
                // Said out loud, because the alternative is a surface that silently stops
                // accepting keystrokes — the defect W2.2's live run turned up.
                HStack(spacing: 4) {
                    Image(systemName: "lock.fill").font(.system(size: 9))
                    Text(reason).font(.ui(10, .medium)).lineLimit(1)
                }
                .foregroundStyle(Theme.blocked)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Theme.blocked.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .help(reason)
            }
            Spacer()
            branchMenu
            threadsButton
            stagingButtons
            commentButton
            if !session.comments.isEmpty { sendButton }
            splitToggle
            GhostIconButton(systemName: "arrow.clockwise", help: "Refresh") { session.load() }
            GhostIconButton(systemName: "xmark", help: "Close (⌘G)") { store.diffPanelOpen = false }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    /// Hands off to the existing worktree flow, which resolves the repo from the
    /// workspace's default directory rather than from this pane.
    private func createWorktree() {
        let name = worktreeName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let located = locatePane(session.paneID, in: store.workspaces)
        else { return }
        let workspace = store.workspaces[located.ws]
        guard workspace.defaultPath != nil else {
            session.lastError = "Set the workspace's directory first (right-click the "
                + "workspace in the sidebar → Set Directory…) — worktrees are created from it."
            return
        }
        store.newWorktreeTab(inWorkspace: workspace.id, name: name)
    }

    /// Current branch, with the branch list and "new worktree tab" behind it.
    ///
    /// The list is read once when the workbench opens (see `onAppear`), not per render.
    @ViewBuilder private var branchMenu: some View {
        if let branch = session.branchName {
            HStack(spacing: 4) {
                // **Outside** the Menu, not in its label. macOS renders a SwiftUI `Menu`'s
                // custom label through an NSPopUpButton, which scales image content to the
                // control's height — inside the label this glyph measured 18pt of ink
                // whatever frame it was given, so no `size:` had any effect at all.
                //
                // 11 matches the text's ink height: 8.25pt of glyph against 8.25pt of
                // DM Sans at 11pt. Sizing to the x-height instead (8, ~6pt of ink) reads as
                // obviously undersized. Measured, and eyeballed at 8/9/10/11/12 — see
                // scratchpad/menu.
                TablerIcon(paths: Tabler.gitBranch, size: 11)
                Menu {
                    Section("Switch to") {
                        ForEach(session.branches.filter { $0 != branch }, id: \.self) { name in
                            Button(name) { session.checkout(branch: name) }
                        }
                    }
                    Divider()
                    Button("New Worktree Tab…") { worktreeName = ""; worktreePrompt = true }
                } label: {
                    Text(branch).font(.ui(11, .medium)).lineLimit(1)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .focusable(false)
                .disabled(session.writing)
            }
            .foregroundStyle(Theme.textSecondary)
            .help("Branch — switch, or start a worktree")
        }
    }

    /// The dense one-line summary: magnitude, file count, and what we're comparing to.
    @ViewBuilder private var summary: some View {
        if session.resolveOnly {
            HStack(spacing: 6) {
                TablerIcon(paths: Tabler.gitMerge, size: 11).foregroundStyle(Theme.error)
                Text(session.mergeState.summary ?? "Resolving")
                    .font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
        } else if session.scope == .files {
            HStack(spacing: 6) {
                Text("\(session.openedPaths.count) open")
                    .font(.ui(11)).foregroundStyle(Theme.textSecondary)
                Text("·").foregroundStyle(Theme.textDim)
                Text("⌘P to open a file").font(.ui(11)).foregroundStyle(Theme.textDim)
            }
        } else {
            diffSummary
        }
    }

    private var diffSummary: some View {
        HStack(spacing: 6) {
            Text("+\(totalAdded)").font(.mono(11, .medium)).foregroundStyle(Color(hex: Theme.Diff.addition))
            Text("−\(totalRemoved)").font(.mono(11, .medium)).foregroundStyle(Color(hex: Theme.Diff.deletion))
            Text("·").foregroundStyle(Theme.textDim)
            if let focused = session.focusedFile {
                Button { session.focus(file: nil) } label: {
                    HStack(spacing: 4) {
                        Text((focused as NSString).lastPathComponent).font(.ui(11, .medium))
                        Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                    }
                    .foregroundStyle(Theme.textPrimary)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.surface3)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                .help("Showing one file — click to show all \(uniqueFileCount)")
            } else {
                Text("\(uniqueFileCount) file\(uniqueFileCount == 1 ? "" : "s")")
                    .font(.ui(11)).foregroundStyle(Theme.textSecondary)
            }
            if let base = session.baseLabel {
                Text("·").foregroundStyle(Theme.textDim)
                Text("→ \(base)").font(.ui(11)).foregroundStyle(Theme.textSecondary)
            }
        }
    }

    // Both halves: staging everything empties `files`, and a header reading +0 −0 over a
    // full index is a lie.
    private var allShownFiles: [DiffFile] { session.files + session.stagedFiles }
    private var totalAdded: Int { allShownFiles.reduce(0) { $0 + $1.addedCount } }
    private var totalRemoved: Int { allShownFiles.reduce(0) { $0 + $1.removedCount } }

    /// Comment on the cursor's line. Disabled when the cursor isn't on a reviewable
    /// line (a file header block, or before the diff has loaded).
    /// Inline ⇄ split. Hidden where a two-column view has no meaning rather than sitting
    /// there disabled: a conflict has three sides, and the Files scope is not a diff.
    @ViewBuilder private var splitToggle: some View {
        if session.splitAvailable {
            Button { session.splitView.toggle() } label: {
                Image(systemName: session.splitView
                      ? "rectangle.split.2x1.fill" : "rectangle.split.2x1")
                    .font(.system(size: 11))
                    .foregroundStyle(session.splitView ? Theme.working : Theme.textSecondary)
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help(session.splitView ? "Inline diff (⌥⌘\\)" : "Side-by-side diff (⌥⌘\\)")
        }
    }

    /// A partially staged file appears in both halves; it is still one file.
    private var uniqueFileCount: Int { Set(allShownFiles.map(\.path)).count }

    @ViewBuilder private var commentButton: some View {
        let anchor = session.cursorStitchedLine.flatMap { session.anchor(atStitchedLine: $0) }
        Button {
            if let anchor { composing = anchor }
        } label: {
            HStack(spacing: 4) {
                TablerIcon(paths: Tabler.message, size: 11)
                Text("Comment").font(.ui(11, .medium))
            }
            .foregroundStyle(anchor == nil ? Theme.textDim : Theme.textSecondary)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(anchor == nil)
        .help(anchor == nil ? "Put the cursor on a diff line to comment" : "Comment on this line (⌘⇧C)")
        .keyboardShortcut("c", modifiers: [.command, .shift])
    }

    /// The pane's PR review threads. Vs-base mode only — they anchor to the PR's diff,
    /// and a working-tree diff has nothing to anchor them to.
    private var paneThreads: [GHReviewThread] {
        guard session.mode == .branchVsBase else { return [] }
        return store.reviewThreads[session.paneID] ?? []
    }

    @ViewBuilder private var threadsButton: some View {
        if !paneThreads.isEmpty {
            let unresolved = PRThreads.unresolvedCount(paneThreads)
            Button { session.threadsPanelOpen.toggle() } label: {
                HStack(spacing: 4) {
                    TablerIcon(paths: Tabler.brandGithub, size: 11)
                    Text(unresolved > 0 ? "\(unresolved) unresolved" : "\(paneThreads.count) threads")
                        .font(.ui(11, .medium))
                }
                .foregroundStyle(Theme.prMerged)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Theme.prMerged.opacity(session.threadsPanelOpen ? 0.18 : 0.10))
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help("Show PR review threads")
        }
    }

    /// Stage / unstage what the gutter ticks say, or the cursor's hunk when nothing is
    /// ticked. Hidden entirely when there is nothing either could act on, rather than
    /// sitting there permanently greyed.
    @ViewBuilder private var stagingButtons: some View {
        if session.hasStagingTarget, session.scope != .files, !session.resolveOnly {
            let count = session.selectedLines.count
            HStack(spacing: 4) {
                pill(count > 0 ? "Stage \(count)" : "Stage hunk",
                     hint: "⌘⏎", color: Color(hex: Theme.Diff.addition)) {
                    session.stageSelection()
                }
                pill("Unstage", hint: "⌘⌥⏎", color: Color(hex: Theme.Diff.deletion)) {
                    session.unstageSelection()
                }
            }
        }
    }

    private func pill(_ title: String, hint: String, color: Color,
                     _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.ui(11, .medium))
                .foregroundStyle(session.writing ? Theme.textDim : color)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(color.opacity(session.writing ? 0.05 : 0.14))
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(session.writing)
        .help("\(title) (\(hint))")
    }

    private var sendButton: some View {
        Button {
            store.submitReview(session.comments, toPane: session.paneID)
            session.comments.removeAll()
            store.diffPanelOpen = false
        } label: {
            Text("Send to agent \(session.comments.count)")
                .font(.ui(11, .semibold)).foregroundStyle(Theme.working)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Theme.working.opacity(0.16))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
    }

    // MARK: - Rail

    private var rail: some View {
        VStack(spacing: 0) {
            // No scope pill while unmerged: there is one scope, so the segmented control is
            // a label wearing a button's clothes — and the rail's own CONFLICTED header says
            // the same thing an inch below it.
            if !session.resolveOnly {
                scopeList
                Rectangle().fill(Theme.divider).frame(height: 1)
            }
            if session.scope == .files { plainFilesList } else { fileList }
            if !session.comments.isEmpty {
                Rectangle().fill(Theme.divider).frame(height: 1)
                pendingComments
            }
            if let error = session.lastError {
                Rectangle().fill(Theme.divider).frame(height: 1)
                errorRow(error)
            }
            Rectangle().fill(Theme.divider).frame(height: 1)
            commitBox
        }
        .background(Theme.surface1)
    }

    /// Git's own words, inline. A rejected patch or a failed push has a reason and the
    /// rail is where it stays visible until acted on — a toast would vanish unread.
    private func errorRow(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10)).foregroundStyle(Theme.error)
            Text(error)
                .font(.mono(10)).foregroundStyle(Theme.error)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            GhostIconButton(systemName: "xmark", help: "Dismiss") { session.lastError = nil }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Theme.error.opacity(0.08))
    }

    // MARK: - Commit

    private var commitBox: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $session.commitDraft)
                .font(.mono(11))
                .scrollContentBackground(.hidden)
                .foregroundStyle(Theme.textPrimary)
                .frame(height: 56)
                .padding(.horizontal, 5).padding(.vertical, 4)
                .background(Theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .overlay(alignment: .topLeading) {
                    if session.commitDraft.isEmpty {
                        Text("Commit message")
                            .font(.mono(11)).foregroundStyle(Theme.textDim)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .focused($commitFocused)

            HStack(spacing: 6) {
                commitButton("Commit", prominent: true) { session.commit(push: false) }
                commitButton("& Push", prominent: false, blocked: session.pushBlockedReason) {
                    session.commit(push: true)
                }
                Spacer(minLength: 0)
                if let branch = session.branchName {
                    Text(branch).font(.mono(9.5)).foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    /// `blocked` is a reason string: the button still renders, disabled, and says why on
    /// hover — never a dead control with no explanation.
    private func commitButton(_ title: String, prominent: Bool, blocked: String? = nil,
                              _ action: @escaping () -> Void) -> some View {
        let enabled = session.canCommit && blocked == nil
        return Button(action: action) {
            Text(title)
                .font(.ui(11, .semibold))
                .foregroundStyle(enabled ? (prominent ? Theme.working : Theme.textSecondary)
                                         : Theme.textDim)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background((prominent ? Theme.working : Theme.textSecondary)
                    .opacity(enabled ? 0.16 : 0.06))
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(!enabled)
        .help(blocked ?? commitHint)
    }

    private var commitHint: String {
        if session.writing { return "A git write is in flight…" }
        if session.stagedPaths.isEmpty { return "Stage something first (⌘⏎ on a hunk)" }
        if session.commitDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Write a commit message (⌘K)"
        }
        return "Commit the staged changes"
    }

    /// The outgoing review batch. Lives in the rail rather than inline under each row
    /// until overlay anchoring lands, so a comment is never invisible after scrolling.
    private var pendingComments: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PENDING \(session.comments.count)")
                .font(.ui(9.5, .semibold)).foregroundStyle(Theme.textDim)
            ScrollView {
                VStack(spacing: 5) {
                    ForEach(session.comments) { comment in
                        CommentBubble(comment: comment) { session.removeComment(comment.id) }
                    }
                }
            }
            .frame(maxHeight: 200)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    /// Scope as one segmented pill rather than a stack of rows with a tick.
    ///
    /// Segments share the width equally instead of sizing to their text, so a long base
    /// label (`origin/feature/…`) truncates inside its own segment rather than pushing the
    /// others off the rail.
    /// One selectable scope.
    private struct ScopeOption: Identifiable {
        let id: WorkbenchScope
        let title: String
        let tint: Color?
        /// A count of things needing attention, shown as a filled badge. Deliberately not
        /// folded into the title: "Files 3" reads as *three files*, when the scope holds
        /// your open files as well and the number is really "three of these are broken".
        var badge: Int? = nil
    }

    private var scopeOptions: [ScopeOption] {
        // Outside a repo there is nothing to diff against, so Files is the only scope —
        // and there it is the whole workbench.
        var options: [ScopeOption] = session.isRepo ? [
            ScopeOption(id: .workingTree, title: "Working", tint: nil),
            ScopeOption(id: .vsBase, title: "vs \(session.baseName ?? "base")", tint: nil),
        ] : []
        options += [
            // Conflicts live here rather than in a scope of their own: a file you have to
            // fix is still a file, and hiding it behind a second tab put the most urgent
            // thing in the workbench one click out of sight.
            ScopeOption(id: .files, title: "Files", tint: nil),
        ]
        if !paneThreads.isEmpty {
            let unresolved = PRThreads.unresolvedCount(paneThreads)
            options.append(ScopeOption(
                id: .threads, title: "Threads",
                tint: unresolved > 0 ? Theme.prMerged : nil,
                badge: unresolved > 0 ? unresolved : nil))
        }
        return options
    }

    /// Scope as a segmented pill, wrapped onto two rows once there are more than three.
    ///
    /// Segments share width equally within a row so a long base label (`origin/feature/…`)
    /// truncates inside its own segment rather than pushing the others off the rail. That
    /// alone was fine at two scopes and unreadable at five — 260pt split five ways leaves
    /// about seven characters, so every segment ellipsised at once. Wrapping keeps the equal
    /// widths *and* the labels.
    private var scopeList: some View {
        let options = scopeOptions
        let rows: [[ScopeOption]] = options.count > 3
            ? stride(from: 0, to: options.count, by: 2).map {
                Array(options[$0..<min($0 + 2, options.count)])
              }
            : [options]
        return VStack(spacing: 3) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 2) {
                    ForEach(row) { option in
                        scopeSegment(option.title, active: session.scope == option.id,
                                     tint: option.tint, badge: option.badge) {
                            session.setScope(option.id)
                        }
                    }
                    // A trailing odd segment keeps its half-width rather than stretching to
                    // fill the row, so the grid still reads as a grid.
                    if row.count == 1, rows.count > 1 { Color.clear.frame(maxWidth: .infinity) }
                }
                .padding(2)
                .background(Theme.surface2)
                .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    /// One segment. The filled capsule *is* the selected state, so there's no tick to carry.
    private func scopeSegment(_ title: String, active: Bool, tint: Color? = nil,
                              badge: Int? = nil,
                              _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(title)
                    .font(.ui(11, active ? .semibold : .medium))
                    .foregroundStyle(tint ?? (active ? Theme.textPrimary : Theme.textSecondary))
                    .lineLimit(1)
                if let badge {
                    Text("\(badge)")
                        .font(.ui(9, .bold))
                        .foregroundStyle(Theme.ground)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(tint ?? Theme.textSecondary)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 3)
            .frame(maxWidth: .infinity)
            .background(active ? Theme.surface3 : Color.clear)
            .clipShape(Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain).focusable(false)
        .help(badge.map { "\(title) — \($0) conflicted" } ?? title)
    }

    // MARK: - Files scope

    /// The workbench as a plain editor: no diff, no staging sections, just what is open.
    ///
    /// The rail deliberately does **not** grow a file browser. `⌘P` already fuzzy-matches
    /// every file git knows about, and a second, worse browser beside it would be two ways
    /// to do one thing.
    private var plainFilesList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // Resolver only while unmerged: opening other files mid-merge is a way to
                // make a broken tree worse, and none of it is editable anyway.
                if session.resolveOnly {
                    conflictsSection
                } else {
                    plainFilesBody
                }
            }
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var plainFilesBody: some View {
        Group {
                Button { session.openFinder() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").font(.system(size: 10))
                        Text("Find File…").font(.ui(11, .medium))
                        Spacer(minLength: 0)
                        Text("⌘P").font(.mono(9.5)).foregroundStyle(Theme.textDim)
                    }
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                // ⌘P only reaches files under the pane's directory. This reaches anything.
                Button(action: openAnyFile) {
                    HStack(spacing: 6) {
                        Image(systemName: "folder").font(.system(size: 10))
                        Text("Open…").font(.ui(11, .medium))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)

                if session.openedPaths.isEmpty {
                    if !session.hasConflicts {
                        Text("Nothing open yet.")
                            .font(.ui(10)).foregroundStyle(Theme.textDim)
                            .padding(.horizontal, 12).padding(.top, 4)
                    }
                } else {
                    openedFilesSection
                }
        }
    }

    /// Open any file on disk, including one nowhere near the pane's directory.
    private func openAnyFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.directoryURL = URL(fileURLWithPath: session.cwd, isDirectory: true)
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { session.openFile(absolutePath: url.path) }
    }

    // MARK: - Conflicts

    /// The unmerged files, at the top of the Files rail: the operation banner, one row per
    /// conflicted file with the bulk actions that carry a rebase, and the escape hatch.
    @ViewBuilder private var conflictsSection: some View {
        Group {
            if let summary = session.mergeState.summary {
                HStack(alignment: .top, spacing: 6) {
                    TablerIcon(paths: Tabler.gitBranch, size: 11)
                        .foregroundStyle(Theme.blocked)
                    Text(summary)
                        .font(.ui(10.5, .medium)).foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.blocked.opacity(0.10))
            }

            ForEach(session.divergentFiles, id: \.self) { path in
                divergentRow(path)
            }

            Text("CONFLICTED \(session.mergeFiles.count)")
                .font(.ui(10, .semibold)).foregroundStyle(Theme.error)
                .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)

            ForEach(session.mergeFiles, id: \.path) { file in
                conflictRow(file)
            }

            if session.mergeState.isActive { abortRow }
            Rectangle().fill(Theme.divider).frame(height: 1).padding(.top, 10)
        }
    }

    /// Our diff3 found a different number of regions than git wrote markers for.
    ///
    /// Surfaced rather than swallowed: computing our own three-way merge instead of scraping
    /// git's markers is the right call, but the one thing it can get wrong is silently
    /// auto-resolving something git asked about. If the counts disagree, say so.
    private func divergentRow(_ path: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10)).foregroundStyle(Theme.blocked)
            Text("\((path as NSString).lastPathComponent): our region count differs from "
                 + "git's markers — check this one carefully.")
                .font(.ui(9.5)).foregroundStyle(Theme.blocked)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Theme.blocked.opacity(0.08))
    }

    private func conflictRow(_ file: MergeFile) -> some View {
        let unresolved = session.unresolvedCount(inFile: file.path)
        let focused = session.focusedFile == file.path
        return VStack(alignment: .leading, spacing: 3) {
            // Plain content, not a Button: the tap lives on the whole card below, so the
            // action row and the padding select the file too. A Button here would have
            // claimed only its own line and left the rest of the card dead.
            Group {
                HStack(spacing: 6) {
                    TablerIcon(paths: unresolved == 0 ? Tabler.check : Tabler.gitMerge,
                               size: 12)
                        .foregroundStyle(unresolved == 0
                                         ? Color(hex: Theme.Diff.addition) : Theme.error)
                    Text((file.path as NSString).lastPathComponent)
                        .font(.ui(12, focused ? .semibold : .regular))
                        .foregroundStyle(unresolved == 0 ? Theme.textPrimary : Theme.error)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(conflictSummary(file, unresolved: unresolved))
                        .font(.mono(9.5)).foregroundStyle(Theme.textDim)
                }
                // `contentShape` alone only covers the label's *measured* area, and a
                // Button's label sizes to its content — so the empty space past the summary
                // was dead. The row has to be told to fill before it can all be a target.
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 4) {
                if file.kind.isWholeFile {
                    // One decision, so one click — no side-then-Resolve two-step. Picking a
                    // side used to change nothing visible while silently enabling Resolve,
                    // which read as a dead end. The labels say what *happens*, because
                    // "keep ours" is meaningless when ours is the deletion.
                    ForEach(session.wholeFileChoices(file), id: \.title) { choice in
                        miniAction(choice.title, help: choice.help) {
                            session.resolveWholeFile(path: file.path, keeping: choice.side)
                        }
                    }
                    Spacer(minLength: 0)
                } else if session.isEdited(file.path) {
                    // The accept controls would overwrite hand-written text, so they step
                    // aside until the edit is dropped rather than discarding it silently.
                    Text("edited").font(.ui(9.5, .medium))
                        .foregroundStyle(Theme.blocked)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.blocked.opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                    miniAction("Revert", help: "Discard your edits and restore the controls") {
                        session.revertEdit(inFile: file.path)
                    }
                    Spacer(minLength: 0)
                    resolveButton(file, unresolved: unresolved)
                } else {
                    // Named for the branches, not "ours"/"theirs" — mid-rebase those words
                    // mean the opposite of what a reader expects.
                    miniAction("All \(file.oursLabel)",
                               help: "Take every conflict from \(file.oursLabel)") {
                        session.resolveAll(inFile: file.path, as: .ours)
                    }
                    miniAction("All \(file.theirsLabel)",
                               help: "Take every conflict from \(file.theirsLabel)") {
                        session.resolveAll(inFile: file.path, as: .theirs)
                    }
                    Spacer(minLength: 0)
                    resolveButton(file, unresolved: unresolved)
                }
            }
            .padding(.leading, 17)
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(focused ? Theme.surface3 : Color.clear)
        // The whole card, both rows and the padding. The buttons inside still take their own
        // taps — SwiftUI gives them precedence — so this only catches what they don't.
        .contentShape(Rectangle())
        .onTapGesture { session.focus(file: file.path) }
        .help(file.path)
    }

    /// A small pill action in a conflict row.
    private func miniAction(_ title: String, help: String,
                            _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title)
                .font(.ui(9.5, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Theme.surface3)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(session.writing)
        .help(help)
    }

    private func resolveButton(_ file: MergeFile, unresolved: Int) -> some View {
        Button("Resolve") { session.resolveFile(path: file.path) }
            .buttonStyle(.plain).focusable(false)
            .font(.ui(10, .semibold))
            .foregroundStyle(session.canResolveFile(file.path)
                             ? Color(hex: Theme.Diff.addition) : Theme.textDim)
            .disabled(!session.canResolveFile(file.path))
            .help(unresolved > 0
                  ? "Decide every conflict in this file first"
                  : "Write the merged file and stage it")
    }

    private func conflictSummary(_ file: MergeFile, unresolved: Int) -> String {
        if file.kind.isWholeFile {
            switch file.kind {
            case .deletedByThem: return "deleted by \(file.theirsLabel)"
            case .deletedByUs:   return "deleted by \(file.oursLabel)"
            case .binary:        return "binary"
            default:             return "whole file"
            }
        }
        return unresolved == 0 ? "ready" : "\(unresolved)/\(file.conflicts.count)"
    }

    private func miniButton(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text("All \(title)")
                .font(.ui(9.5, .medium)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(session.writing)
        .help("Take every conflict in this file from \(title)")
    }

    /// The escape hatch. A resolver without one is a trap.
    private var abortRow: some View {
        HStack(spacing: 0) {
            Button(role: .destructive) { abortConfirm = true } label: {
                Text("Abort \(abortVerb)")
                    .font(.ui(10, .medium)).foregroundStyle(Theme.error)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.error.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false).disabled(session.writing)
            .help("Throw away the whole \(abortVerb) and go back")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.top, 12)
    }

    private var abortVerb: String {
        switch session.mergeState.operation {
        case .merge:      return "merge"
        case .rebase:     return "rebase"
        case .cherryPick: return "cherry-pick"
        case .none:       return "operation"
        }
    }

    /// Changed files, split Staged / Unstaged, and grouped inside each split under dim
    /// uppercase directory headers rather than shown as flat full paths — much easier to
    /// scan on a wide diff.
    private var fileList: some View {
        // Built once per render and threaded down. They were computed properties that
        // rebuilt a Set from every buffer, and `fileRow` asked for both — 287 rows meant
        // 574 set constructions per body evaluation.
        let flags = (dirty: session.dirtySources, stale: session.staleSources)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                openedFilesSection
                allFilesRow
                ForEach(sections, id: \.kind) { section in
                    sectionHeader(section)
                    ForEach(section.groups, id: \.directory) { group in
                        // One line, head-truncated: a vendored path like
                        // spike/seam1/Sources/Editor/CodeEditSourceEditor/Extensions
                        // wrapped to three lines and buried the only useful part.
                        Text(group.directory.isEmpty ? "ROOT" : group.directory.uppercased())
                            .font(.ui(9.5, .semibold)).foregroundStyle(Theme.textDim)
                            .lineLimit(1).truncationMode(.head)
                            .help(group.directory)
                            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 3)
                        ForEach(group.files, id: \.path) { file in
                            fileRow(file, kind: section.kind, flags: flags)
                            // The reconcile choice rides under the row that already carries
                            // the "changed on disk" marker. It can't go on the file header
                            // band, where the roadmap put it: `TextView.hitTest` returns the
                            // text view for any point inside it, so a block never sees a
                            // click (the same reason the gap arrows live in the gutter).
                            if flags.stale.contains(sourceID(of: file.path)) {
                                reconcileRow(path: file.path)
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Files opened through ⌘P — listed separately because they are not part of the diff,
    /// and each needs a way out or you are stuck with it in the document.
    @ViewBuilder private var openedFilesSection: some View {
        if !session.openedPaths.isEmpty {
            Text("OPEN").font(.ui(9.5, .semibold)).foregroundStyle(Theme.textDim)
                .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 3)
            ForEach(session.openedPaths, id: \.self) { path in
                HStack(spacing: 6) {
                    Button {
                        if let row = session.firstStitchedLine(ofFile: path) {
                            session.requestScroll(toStitchedLine: row)
                        }
                    } label: {
                        HStack(spacing: 6) {
                            TablerIcon(paths: Tabler.squareDot, size: 12)
                                .foregroundStyle(Theme.textDim)
                            Text((path as NSString).lastPathComponent)
                                .font(.ui(12)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                            Spacer(minLength: 4)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).focusable(false)
                    .help(path)
                    Button { session.closeOpenedFile(path: path) } label: {
                        Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Theme.textDim)
                            .frame(width: 18, height: 18).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).focusable(false)
                    .help("Close this file")
                }
                .padding(.horizontal, 12).padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Back to the whole diff. Shown only while a file is focused, so the rail doesn't
    /// carry a permanently-selected row for the default state.
    @ViewBuilder private var allFilesRow: some View {
        if session.focusedFile != nil {
            Button { session.focus(file: nil) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.left").font(.system(size: 9, weight: .semibold))
                    Text("All \(uniqueFileCount) files").font(.ui(11, .medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
        }
    }

    /// Where a listed file stands relative to the index. `committed` exists because
    /// vs-base mode lists everything changed since the base branch, most of which is
    /// already committed — calling those "unstaged" was a lie, and the stage button on
    /// them ran a `git add` that succeeded while moving nothing.
    private enum SectionKind {
        case staged, unstaged, committed

        var title: String {
            switch self {
            case .staged:    return "STAGED"
            case .unstaged:  return "UNSTAGED"
            case .committed: return "COMMITTED"
            }
        }
        /// nil ⇒ no bulk action; the files can't move.
        var bulkAction: (title: String, staged: Bool)? {
            switch self {
            case .staged:    return ("Unstage all", false)
            case .unstaged:  return ("Stage all", true)
            case .committed: return nil
            }
        }
    }

    private struct FileSection {
        let kind: SectionKind
        let groups: [(directory: String, files: [DiffFile])]
        var files: [DiffFile] { groups.flatMap(\.files) }
    }

    /// A file lands in exactly one section — Staged when the index holds anything for it,
    /// then Unstaged when the working tree does, else Committed. A partially staged file
    /// shows once, under Staged; the gutter is where its individual lines are settled.
    /// The files the rail lists — narrowed to those carrying review threads in the
    /// Threads scope, so the list answers "what have I still to address?".
    private var scopedFiles: [DiffFile] {
        // Falls back to everything if the threads went away (resolved, or the PR closed)
        // while the scope was still selected — an empty rail with no explanation is worse
        // than showing the diff.
        guard session.scope == .threads, !paneThreads.isEmpty else { return allShownFiles }
        let withThreads = Set(paneThreads.map(\.path))
        return allShownFiles.filter { withThreads.contains($0.path) }
    }

    private var sections: [FileSection] {
        var byKind: [SectionKind: [DiffFile]] = [:]
        // In working-tree mode the split is no longer a guess from `stagedPaths`: each file
        // is here because it appeared in one diff or the other, and a partially staged one
        // is genuinely in both.
        if session.scope == .workingTree {
            let shown = Set(scopedFiles.map(\.path))
            byKind[.unstaged] = session.files.filter { shown.contains($0.path) }
            byKind[.staged] = session.stagedFiles.filter { shown.contains($0.path) }
        } else {
            for file in scopedFiles {
                let kind: SectionKind
                if session.stagedPaths.contains(file.path) { kind = .staged }
                else if session.unstagedPaths.contains(file.path) { kind = .unstaged }
                else { kind = .committed }
                byKind[kind, default: []].append(file)
            }
        }
        // Unstaged first in working-tree mode, matching the document's order.
        let order: [SectionKind] = session.scope == .workingTree
            ? [.unstaged, .staged] : [.staged, .unstaged, .committed]
        return order.compactMap { kind in
            guard let files = byKind[kind], !files.isEmpty else { return nil }
            return FileSection(kind: kind, groups: byDirectory(files))
        }
    }

    /// Section header with a bulk stage/unstage for everything under it.
    private func sectionHeader(_ section: FileSection) -> some View {
        HStack(spacing: 6) {
            Text("\(section.kind.title) \(section.files.count)")
                .font(.ui(10, .semibold))
                .foregroundStyle(sectionColor(section.kind))
            if section.kind == .committed, let base = session.baseLabel {
                Text("· in HEAD, not in \(base)")
                    .font(.ui(9)).foregroundStyle(Theme.textDim).lineLimit(1)
            }
            Spacer(minLength: 0)
            if let bulk = section.kind.bulkAction {
                Button(bulk.title) {
                    session.setStaged(bulk.staged, paths: section.files.map(\.path))
                }
                .buttonStyle(.plain).focusable(false)
                .font(.ui(9.5, .medium)).foregroundStyle(Theme.textDim)
                .disabled(session.writing)
            }
        }
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 2)
    }

    private func sectionColor(_ kind: SectionKind) -> Color {
        switch kind {
        case .staged:    return Color(hex: Theme.Diff.addition)
        case .unstaged:  return Theme.textSecondary
        case .committed: return Theme.textDim
        }
    }

    private func byDirectory(_ files: [DiffFile]) -> [(directory: String, files: [DiffFile])] {
        var order: [String] = []
        var byDir: [String: [DiffFile]] = [:]
        for file in files {
            let dir = (file.path as NSString).deletingLastPathComponent
            if byDir[dir] == nil { order.append(dir) }
            byDir[dir, default: []].append(file)
        }
        return order.map { (directory: $0, files: byDir[$0] ?? []) }
    }

    private func fileRow(_ file: DiffFile, kind: SectionKind,
                        flags: (dirty: Set<SourceID>, stale: Set<SourceID>)) -> some View {
        let source = SourceID((session.cwd as NSString).appendingPathComponent(file.path))
        let stale = flags.stale.contains(source)
        let dirty = flags.dirty.contains(source)
        let focused = session.focusedFile == file.path
        return HStack(spacing: 6) {
            // Clicking the name scopes the editor to this file; clicking it again goes
            // back to the whole diff.
            Button { session.focus(file: file.path) } label: {
                HStack(spacing: 6) {
                    TablerIcon(paths: statusGlyph(file.status), size: 12)
                        .foregroundStyle(statusColor(file.status))
                    Text((file.path as NSString).lastPathComponent)
                        .font(.ui(12, focused ? .semibold : .regular))
                        .foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if stale {
                        Text("changed on disk").font(.ui(9.5, .medium))
                            .foregroundStyle(Color(hex: Theme.Diff.modified))
                    } else if dirty {
                        Circle().fill(Theme.blocked).frame(width: 5, height: 5)
                    }
                    Spacer(minLength: 4)
                    if file.addedCount > 0 {
                        Text("+\(file.addedCount)").font(.mono(10))
                            .foregroundStyle(Color(hex: Theme.Diff.addition))
                    }
                    if file.removedCount > 0 {
                        Text("−\(file.removedCount)").font(.mono(10))
                            .foregroundStyle(Color(hex: Theme.Diff.deletion))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Committed files get no button — `git add` on one succeeds and moves
            // nothing, which reads as a broken control.
            if let bulk = kind.bulkAction {
                Button {
                    session.setStaged(bulk.staged, path: file.path)
                } label: {
                    TablerIcon(paths: bulk.staged ? Tabler.squarePlus : Tabler.squareMinus, size: 12)
                        .foregroundStyle(Theme.textDim)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false).disabled(session.writing)
                .help(bulk.staged ? "Stage this file" : "Unstage this file")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(focused ? Theme.surface3 : Color.clear)
        .contentShape(Rectangle())
    }

    private func sourceID(of path: String) -> SourceID {
        SourceID((session.cwd as NSString).appendingPathComponent(path))
    }

    /// The one state that needs a decision: unsaved edits *and* someone wrote the file
    /// underneath them.
    ///
    /// Two choices, not the three the roadmap listed — "merge" opens the W3 resolver, which
    /// doesn't exist yet, and a button that does nothing is worse than no button.
    private func reconcileRow(path: String) -> some View {
        HStack(spacing: 6) {
            Text("changed on disk").font(.ui(9.5, .medium))
                .foregroundStyle(Color(hex: Theme.Diff.modified))
            Button("Keep mine") { session.keepMine(path: path) }
                .buttonStyle(.plain).focusable(false)
                .font(.ui(10, .medium)).foregroundStyle(Theme.textPrimary)
                .help("Write your edits over what's on disk")
            Text("·").foregroundStyle(Theme.textDim)
            Button("Take theirs") { session.takeTheirs(path: path) }
                .buttonStyle(.plain).focusable(false)
                .font(.ui(10, .medium)).foregroundStyle(Theme.textPrimary)
                .help("Discard your edits and reload the file")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.top, 1).padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Colored glyph rather than a bare A/M/D letter.
    private func statusGlyph(_ status: DiffStatus) -> [String] {
        switch status {
        case .added:    return Tabler.squarePlus
        case .deleted:  return Tabler.squareMinus
        case .modified: return Tabler.squareDot
        case .renamed:  return Tabler.squareArrow
        }
    }

    private func statusColor(_ status: DiffStatus) -> Color {
        switch status {
        case .added:    return Color(hex: Theme.Diff.addition)
        case .deleted:  return Color(hex: Theme.Diff.deletion)
        case .modified: return Theme.blocked
        case .renamed:  return Theme.textSecondary
        }
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        // Files first, and deliberately ahead of the repo check: it is a plain editor, and
        // a directory that isn't a repo is still full of files worth editing.
        if session.scope == .files {
            if session.rowOrigins.isEmpty {
                // Either nothing is open, or every conflicted file is whole-file (a binary
                // or a delete/modify) and has no lines to show — those settle in the rail.
                centered(session.resolveOnly
                         ? "Nothing to show here — these conflicts are settled in the list"
                         : "No files open — ⌘P to open one")
            } else {
                EditorHost(session: session)
            }
        } else if !session.isRepo {
            centered("Not a git repository")
        } else if session.loading && !session.hasAnyChanges {
            centered("Loading…")
        } else if !session.hasAnyChanges {
            centered("No changes")
        } else {
            EditorHost(session: session)
        }
    }

    private func centered(_ s: String) -> some View {
        VStack { Spacer(); Text(s).foregroundStyle(Theme.textDim).font(.ui(12)); Spacer() }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
