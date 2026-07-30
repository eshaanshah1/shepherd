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
    @State private var discardConfirm = false
    @State private var stashesExpanded = true
    /// Non-nil while the drop confirmation is up. A stash is the one thing here nothing
    /// undoes, so it is the one action that asks.
    @State private var stashToDrop: Stash?

    var body: some View {
        HStack(spacing: 0) {
            rail
                .frame(width: 260)
                .onboardingAnchor(.workbenchRail, shape: .panel)
            Rectangle().fill(Theme.hairline).frame(width: 1)
            VStack(spacing: 0) {
                header
                Rectangle().fill(Theme.hairline).frame(height: 1)
                WorkbenchPRBand(session: session).environmentObject(store)
                content
                    .onboardingAnchor(.workbenchBuffer, shape: .panel)
                blameStatusStrip
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
        .alert("Discard this conflicted merge?", isPresented: $discardConfirm) {
            Button("Discard changes", role: .destructive) { session.discardLooseConflicts() }
            Button("Cancel", role: .cancel) { }
        } message: {
            // The stash line is information, never a claim that the top entry is your work:
            // a conflicted pop does keep its entry, but nothing in git proves which one.
            Text(SequencePolicy.discardConfirmation(paths: session.looseConflictPaths,
                                                    stashTop: session.stashTopDescription))
        }
        .alert("Delete this stash?",
               isPresented: Binding(get: { stashToDrop != nil },
                                    set: { if !$0 { stashToDrop = nil } })) {
            Button("Drop stash", role: .destructive) {
                if let stash = stashToDrop { session.dropStash(stash) }
                stashToDrop = nil
            }
            Button("Cancel", role: .cancel) { stashToDrop = nil }
        } message: {
            Text(stashToDrop.map { "\($0.ref) — \($0.message)\n\nThis cannot be undone." } ?? "")
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
        // Widened from `hasConflicts` to the whole sequence: resolving the last file used to
        // unlock the workbench while the rebase was still half-applied.
        .onChange(of: session.isMidSequence) { midSequence in
            if midSequence, session.scope != .files { session.setScope(.files) }
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
            key("4", [.control]) { if session.isRepo { session.setScope(.commits) } }
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

    /// Who last touched the line under the cursor, along the bottom of the editor.
    ///
    /// Not in the header. The header already carries the summary, the focused-file chip and
    /// eight controls, and squeezing a fourth text element in there both broke the chip onto
    /// two lines and made the blame read as more summary — unlabelled metadata floating after
    /// `→ master`. Down here it has the full width, it is where every editor puts current-line
    /// blame, and it costs nothing when there is none: the strip only exists while the buffer
    /// is narrowed to a blameable file.
    @ViewBuilder private var blameStatusStrip: some View {
        if let annotation = session.blameAnnotation {
            VStack(spacing: 0) {
                Rectangle().fill(Theme.hairline).frame(height: 1)
                HStack(spacing: 8) {
                    Text("BLAME")
                        .font(.ui(9, .semibold)).foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Theme.surface3)
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                    Text(annotation)
                        .font(.mono(11)).foregroundStyle(Theme.textSecondary)
                        .lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Theme.surface1)
            }
            .help(annotation)
        }
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
        } else if let commit = session.selectedCommit {
            HStack(spacing: 6) {
                Text(commit.shortSha).font(.mono(11, .medium))
                    .foregroundStyle(Theme.textSecondary)
                Text(commit.subject)
                    .font(.ui(11, .medium)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text("·").foregroundStyle(Theme.textDim)
                Text("\(commit.author) · \(CommitHistory.relativeAge(commit.timestamp, now: Date()))")
                    .font(.ui(11)).foregroundStyle(Theme.textDim).lineLimit(1)
            }
        } else if session.scope == .commits {
            HStack(spacing: 6) {
                Text("\(session.commits.count) commit\(session.commits.count == 1 ? "" : "s")")
                    .font(.ui(11)).foregroundStyle(Theme.textSecondary)
                Text("·").foregroundStyle(Theme.textDim)
                Text("pick one to see its diff").font(.ui(11)).foregroundStyle(Theme.textDim)
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
                        // Capped and truncated, not merely un-wrapped. With no line limit a
                        // crowded header broke the name mid-word (`CommitHistory.s / wift`);
                        // `fixedSize` then fixed that by making the chip refuse to shrink, so
                        // its neighbours broke instead (`→ mas / ter`, `+5, / 256`). A max width
                        // makes the chip the thing that gives. Middle truncation because the
                        // extension is worth more than the middle of a long dated filename.
                        Text((focused as NSString).lastPathComponent)
                            .font(.ui(11, .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: 190, alignment: .leading)
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
            // No strip reserved for the traffic lights: the sidebar stays visible beside the
            // workbench and already reserves its own, so the lights never reach this rail.
            // No scope pill while unmerged: there is one scope, so the segmented control is
            // a label wearing a button's clothes — and the rail's own CONFLICTED header says
            // the same thing an inch below it.
            if !session.resolveOnly {
                // A header between the reserved strip and the first row, exactly as the sidebar
                // puts `Workspaces` there. Without it the first scope row butts against the
                // strip, and when that row is the selected one the two read as a single grey
                // block welded to the top of the window.
                Text("SCOPE")
                    .font(.ui(9.5, .semibold)).foregroundStyle(Theme.textDim)
                    // 8pt top, matching the header's own vertical padding across the divider, so
                    // the rail's first line sits on the same baseline as the diff summary.
                    .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                scopeList
                Rectangle().fill(Theme.divider).frame(height: 1)
            }
            if session.scope == .commits { commitsRail }
            else if session.scope == .files { plainFilesList }
            else { fileList }
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

    // MARK: - Commits

    /// The Commits scope's rail: the branch's commits, or the selected commit's files.
    ///
    /// Clicking a commit narrows rather than scrolling, which is the same shape
    /// `focus(file:)` already has — so "clicking in the rail scopes the buffer" is one
    /// behaviour, not two.
    @ViewBuilder private var commitsRail: some View {
        if session.selectedCommit != nil {
            fileList   // its own breadcrumb trail carries the way back up
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let rows = session.planRows {
                        rewriteHeader
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            planRowView(row, index: index, count: rows.count)
                        }
                        rewriteFooter
                    } else {
                    sourcePicker
                    if session.sourceRef == nil {
                        rewriteEntryRow
                        ForEach(session.commits) { commit in
                            commitRow(commit)
                        }
                        baseRow
                        stashSection
                    } else {
                        if session.sourceCommits.isEmpty {
                            Text("Nothing here that this branch does not already have.")
                                .font(.ui(10)).foregroundStyle(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                        }
                        ForEach(session.sourceCommits) { commit in
                            sourceCommitRow(commit)
                        }
                        pickBar
                    }
                    }
                }
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(ThinScrollers())
        }
    }

    // MARK: - Rewrite mode

    /// Entering is a deliberate act, so it gets its own row rather than living on each commit.
    @ViewBuilder private var rewriteEntryRow: some View {
        if !session.commits.isEmpty, !session.isMidSequence {
            HStack(spacing: 0) {
                Button { session.beginRewrite() } label: {
                    Text("Rewrite…")
                        .font(.ui(10, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.surface2)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                .help("Reorder, squash, reword or drop these commits")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.bottom, 6)
        }
    }

    private var rewriteHeader: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("REWRITE").font(.ui(9.5, .semibold)).foregroundStyle(Theme.blocked)
            Text("Newest first, as always. Nothing runs until Apply.")
                .font(.ui(9)).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
    }

    /// One planned commit: move buttons, a verb menu, and a message field when the verb needs
    /// one.
    ///
    /// Reordering is buttons rather than a drag gesture — the rail is a custom `ScrollView`,
    /// not a `List` (deliberately; `List` was a keyboard-focus sink), so `onMove` does not
    /// exist here and a hand-rolled drag is its own piece of work.
    private func planRowView(_ row: PlanRow, index: Int, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                VStack(spacing: 0) {
                    moveButton(up: true, enabled: index > 0) {
                        session.movePlanRow(from: index, to: index - 1)
                    }
                    moveButton(up: false, enabled: index < count - 1) {
                        session.movePlanRow(from: index, to: index + 2)
                    }
                }
                Menu {
                    ForEach(RebaseVerb.allCases, id: \.self) { verb in
                        Button(verb.title) { session.setVerb(verb, forSha: row.commit.sha) }
                    }
                } label: {
                    Text(row.verb.title)
                        .font(.mono(10))
                        .foregroundStyle(row.verb == .drop ? Theme.error : Theme.textSecondary)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .focusable(false)
                .help(row.verb.help)

                VStack(alignment: .leading, spacing: 1) {
                    Text(row.commit.subject)
                        .font(.ui(11, row.verb == .drop ? .regular : .medium))
                        .foregroundStyle(row.verb == .drop ? Theme.textDim : Theme.textPrimary)
                        .strikethrough(row.verb == .drop)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    Text(row.commit.shortSha).font(.mono(9)).foregroundStyle(Theme.textDim)
                }
                Spacer(minLength: 0)
            }
            // Collected before Apply, because `cp '<file>'` substitutes exactly one message —
            // a rebase that stops to ask a question is the failure mode this avoids.
            if row.verb.needsMessage {
                TextField("new message", text: Binding(
                    get: { row.message },
                    set: { session.setPlanMessage($0, forSha: row.commit.sha) }
                ))
                .textFieldStyle(.plain)
                .font(.mono(10))
                .padding(.horizontal, 5).padding(.vertical, 3)
                .background(Theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
    }

    private func moveButton(up: Bool, enabled: Bool,
                            _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: up ? "chevron.up" : "chevron.down")
                .font(.system(size: 7, weight: .semibold))
                .foregroundStyle(enabled ? Theme.textSecondary : Theme.textDim.opacity(0.4))
                .frame(width: 12, height: 10)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(!enabled)
    }

    private var rewriteFooter: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button { session.applyRewrite() } label: {
                    Text("Apply")
                        .font(.ui(11, .semibold))
                        .foregroundStyle(session.rewriteBlockedReason == nil
                                         ? Theme.working : Theme.textDim)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background((session.rewriteBlockedReason == nil
                                     ? Theme.working : Theme.textDim).opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                .disabled(session.rewriteBlockedReason != nil)
                .help(session.rewriteBlockedReason ?? "Rewrite these commits")
                Button { session.cancelRewrite() } label: {
                    Text("Cancel").font(.ui(10)).foregroundStyle(Theme.textDim)
                }
                .buttonStyle(.plain).focusable(false)
                Spacer(minLength: 0)
            }
            // The reason is visible, not only on hover: a disabled button whose explanation
            // needs a mouse is a dead button to anyone driving by keyboard.
            if let reason = session.rewriteBlockedReason, reason != "not rewriting" {
                Text(reason)
                    .font(.ui(9)).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Every commit gets a new sha, which clears the branch's PR review state.")
                .font(.ui(9)).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
    }

    /// Where cherry-pick sources come from. One `for-each-ref`, sorted newest-first, with the
    /// branches git has checked out somewhere marked — in Shepherd those are the agents.
    ///
    /// The `Menu` carries **text only**: macOS renders one through an NSPopUpButton, which
    /// rescales image content to the control's height, so an icon in the label ignores `size:`.
    @ViewBuilder private var sourcePicker: some View {
        if !session.sourceRefs.isEmpty {
            HStack(spacing: 6) {
                Text("from").font(.ui(9.5)).foregroundStyle(Theme.textDim)
                Menu {
                    Button("This branch") { session.selectSourceRef(nil) }
                    Divider()
                    ForEach(session.sourceRefs) { ref in
                        Button(ref.isCheckedOut ? "\(ref.name)  ·  checked out" : ref.name) {
                            session.selectSourceRef(ref)
                        }
                    }
                } label: {
                    Text(session.sourceRef?.name ?? "this branch")
                        .font(.ui(10.5, .medium)).foregroundStyle(Theme.textSecondary)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .focusable(false)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 4)
        }
    }

    /// A source commit: tick to pick, click the body to preview it read-only.
    private func sourceCommitRow(_ commit: Commit) -> some View {
        let ticked = session.pickSelection.contains(commit.sha)
        let active = session.selectedCommit?.sha == commit.sha
        return HStack(alignment: .top, spacing: 7) {
            Button {
                if ticked { session.pickSelection.remove(commit.sha) }
                else { session.pickSelection.insert(commit.sha) }
            } label: {
                // The glyph shows the *action*, matching the staging buttons in this same rail:
                // a plus adds this commit to the pick, a minus takes it back out.
                TablerIcon(paths: ticked ? Tabler.squareMinus : Tabler.squarePlus, size: 12)
                    .foregroundStyle(ticked ? Theme.working : Theme.textDim)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help(ticked ? "Remove from the pick" : "Cherry-pick this commit")

            Button { session.selectCommit(active ? nil : commit) } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(commit.subject)
                        .font(.ui(11.5, active ? .semibold : .regular))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 5) {
                        Text(commit.shortSha).font(.mono(9.5))
                        Text("·")
                        Text(CommitHistory.relativeAge(commit.timestamp, now: Date()))
                            .font(.mono(9.5))
                    }
                    .foregroundStyle(Theme.textDim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help("\(commit.subject)\n\(commit.author)")
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(active ? Theme.surface3 : Color.clear)
    }

    @ViewBuilder private var pickBar: some View {
        if !session.pickSelection.isEmpty {
            HStack(spacing: 8) {
                Button { session.cherryPickSelection() } label: {
                    Text("Cherry-pick \(session.pickSelection.count)")
                        .font(.ui(11, .semibold)).foregroundStyle(Theme.working)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Theme.working.opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false).disabled(session.writing)
                .help("Apply the ticked commits onto this branch, oldest first")
                Button { session.pickSelection = [] } label: {
                    Text("Clear").font(.ui(10)).foregroundStyle(Theme.textDim)
                }
                .buttonStyle(.plain).focusable(false)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }

    /// Stashes live under the commit list rather than in a scope of their own. A stash is a
    /// kind of history, which is what this scope is — and a fifth scope segment would cost a
    /// second row of chrome for something used a few times a week.
    @ViewBuilder private var stashSection: some View {
        if !session.stashes.isEmpty {
            Button { stashesExpanded.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: stashesExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                    Text("STASHES \(session.stashes.count)")
                        .font(.ui(9.5, .semibold))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.textDim)
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)

            if stashesExpanded {
                ForEach(session.stashes) { stash in
                    stashRow(stash)
                }
            }
        }
    }

    /// Two lines like `commitRow`, for the same reason: the message is the part you read, and
    /// a ~220pt row cannot hold it beside a ref and an age.
    private func stashRow(_ stash: Stash) -> some View {
        let active = session.selectedStash?.sha == stash.sha
        return VStack(alignment: .leading, spacing: 3) {
            Button { session.selectStash(active ? nil : stash) } label: {
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: "archivebox")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(stash.message)
                            .font(.ui(11.5, active ? .semibold : .regular))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 5) {
                            Text(stash.ref).font(.mono(9.5))
                            Text("·")
                            Text(CommitHistory.relativeAge(stash.timestamp, now: Date()))
                                .font(.mono(9.5))
                        }
                        .foregroundStyle(Theme.textDim)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help(stash.message)

            // Actions only on the open one, so the list stays scannable.
            if active {
                HStack(spacing: 6) {
                    stashAction("Apply", help: "Apply and keep the stash") {
                        session.applyStash(stash, pop: false)
                    }
                    stashAction("Pop", help: "Apply and remove the stash") {
                        session.applyStash(stash, pop: true)
                    }
                    stashAction("Drop", help: "Delete this stash", destructive: true) {
                        stashToDrop = stash
                    }
                    Spacer(minLength: 0)
                }
                // Untracked files are in the stash's third parent, which the first-parent diff
                // cannot show. Named, not fabricated into rows.
                if !session.stashUntrackedPaths.isEmpty {
                    Text("untracked (not previewed): "
                         + session.stashUntrackedPaths.joined(separator: ", "))
                        .font(.ui(9)).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(active ? Theme.surface3 : Color.clear)
    }

    /// Stashing is the neighbour of committing — both are "put this somewhere and clean the
    /// tree" — and the box that already names the change is right here, so the draft becomes
    /// the stash message.
    ///
    /// The `Menu` gets **text only**: macOS renders one through an NSPopUpButton, which
    /// rescales image content to the control's height, so an icon inside the label ignores its
    /// `size:` entirely.
    @ViewBuilder private var stashMenu: some View {
        if session.isRepo && !session.resolveOnly {
            Menu {
                Button("Stash all changes") { session.createStash(scope: .all) }
                Button("Stash staged only") { session.createStash(scope: .stagedOnly) }
                Button("Stash, including untracked") {
                    session.createStash(scope: .includingUntracked)
                }
            } label: {
                Text("Stash").font(.ui(11, .semibold)).foregroundStyle(Theme.textSecondary)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .focusable(false)
            .disabled(session.writing)
            .help("Park these changes; the commit message becomes the stash message")
        }
    }

    private func stashAction(_ title: String, help: String, destructive: Bool = false,
                             _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.ui(10, .medium))
                .foregroundStyle(destructive ? Theme.error : Theme.textSecondary)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background((destructive ? Theme.error : Theme.textSecondary).opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(session.writing)
        .help(help)
    }

    /// Two lines: the subject, then its metadata dimmed beneath.
    ///
    /// One line could not work. The subject is the only part you actually read, and sharing a
    /// ~220pt row with an 8-character sha and an age left it about twenty characters —
    /// `docs: -only-testing on…`. Giving the subject the full width and dropping sha and age to
    /// a second line costs about a third of the visible rows and is the trade worth making.
    private func commitRow(_ commit: Commit) -> some View {
        let active = session.selectedCommit?.sha == commit.sha
        return Button { session.selectCommit(commit) } label: {
            HStack(alignment: .top, spacing: 7) {
                Circle().fill(Color(hex: Theme.Diff.modified))
                    .frame(width: 5, height: 5)
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 1) {
                    Text(commit.subject)
                        .font(.ui(11.5, active ? .semibold : .regular))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 5) {
                        Text(commit.shortSha).font(.mono(9.5))
                        Text("·")
                        Text(CommitHistory.relativeAge(commit.timestamp, now: Date()))
                            .font(.mono(9.5))
                    }
                    .foregroundStyle(Theme.textDim)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? Theme.surface3 : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
        .help("\(commit.subject)\n\(commit.author)")
    }

    /// Where the branch started. Not clickable — it is the boundary of the range, not a
    /// commit of yours, and its diff is the vs-base scope.
    @ViewBuilder private var baseRow: some View {
        if let base = session.baseName {
            HStack(spacing: 7) {
                Circle().strokeBorder(Theme.textDim, lineWidth: 1)
                    .frame(width: 5, height: 5)
                Text(base).font(.mono(10)).foregroundStyle(Theme.textDim)
                Text("base").font(.ui(10)).foregroundStyle(Theme.textDim)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 3)
        }
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
                stashMenu
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
            .background(ThinScrollers())
            .frame(maxHeight: 200)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    /// One selectable scope, as a row.
    ///
    /// Rows rather than a segmented pill. The pill sized every segment equally, so a long base
    /// label truncated inside its own segment; past three scopes it wrapped to a second line,
    /// and at four — which a repo now always has — it cost two rows *and* ellipsised. A row per
    /// scope gives each label the full rail width and scales to five without wrapping. This is
    /// also what the original spec mockup had.
    private struct ScopeOption: Identifiable {
        let id: WorkbenchScope
        let title: String
        let tint: Color?
        /// Right-aligned, out of the label's way — so it can be a plain count of what the scope
        /// holds rather than only ever meaning "this many things are wrong".
        var count: Int? = nil
        var help: String = ""
    }

    private var scopeOptions: [ScopeOption] {
        // Outside a repo there is nothing to diff against, so Files is the only scope —
        // and there it is the whole workbench.
        // Working and vs-base carry **no** count. `session.files` holds whatever the *current*
        // scope loaded, so a number on either would show the other's file count while you stood
        // in the other one. Only the counts that are scope-independent — conflicts, commits,
        // threads, all loaded regardless of where you are — can be shown honestly.
        var options: [ScopeOption] = session.isRepo ? [
            ScopeOption(id: .workingTree, title: "Working", tint: nil,
                        help: "Uncommitted changes (⌃1)"),
            ScopeOption(id: .vsBase, title: "vs \(session.baseName ?? "base")", tint: nil,
                        help: "Everything since the base branch (⌃2)"),
        ] : []
        options += [
            // Conflicts live here rather than in a scope of their own: a file you have to
            // fix is still a file, and hiding it behind a second tab put the most urgent
            // thing in the workbench one click out of sight.
            ScopeOption(id: .files, title: "Files", tint: nil,
                        count: session.hasConflicts ? session.mergeFiles.count : nil,
                        help: "Conflicts and files opened with ⌘P (⌃3)"),
        ]
        // Only once there are commits to show: the rail must not reserve space for a scope
        // that does not exist yet. Gated on `isRepo` like Working and vs-base — outside a repo
        // there is no history, and Files is the whole workbench.
        if session.isRepo, !session.commits.isEmpty {
            options.append(ScopeOption(id: .commits, title: "Commits", tint: nil,
                                       count: session.commits.count,
                                       help: "This branch's commits (⌃4)"))
        }
        if !paneThreads.isEmpty {
            let unresolved = PRThreads.unresolvedCount(paneThreads)
            options.append(ScopeOption(
                id: .threads, title: "Threads",
                tint: unresolved > 0 ? Theme.prMerged : nil,
                count: unresolved > 0 ? unresolved : nil,
                help: "PR review threads still to address"))
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
        VStack(alignment: .leading, spacing: 0) {
            ForEach(scopeOptions) { option in
                scopeRow(option)
            }
        }
        .padding(.vertical, 4)
        // **The list must never flex vertically.** The rail is a `VStack`, which hands out
        // leftover height to whichever child will take it; without this the active row absorbed
        // it — the highlight grew to cover two and a half rows and shoved `Working` out of
        // sight. Per-row heights cannot win that argument, because the stretch arrives from the
        // parent. `fixedSize` makes the list state its height and refuse the offer.
        .fixedSize(horizontal: false, vertical: true)
    }

    /// One scope, as a row.
    ///
    /// A leading bar marks the active one — no capsule, no equal-width segments, so the label
    /// gets the whole rail and a long base name (`origin/feature/…`) has room instead of
    /// ellipsising. The count sits right-aligned, where it does not compete with the name.
    private func scopeRow(_ option: ScopeOption) -> some View {
        let active = session.scope == option.id
        return Button { session.setScope(option.id) } label: {
            HStack(spacing: 6) {
                Text(option.title)
                    .font(.ui(11.5, active ? .semibold : .regular))
                    .foregroundStyle(option.tint ?? (active ? Theme.textPrimary
                                                           : Theme.textSecondary))
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                if let count = option.count {
                    Text("\(count)")
                        .font(.mono(10))
                        .foregroundStyle(option.tint ?? Theme.textDim)
                }
            }
            .padding(.leading, 10).padding(.trailing, 12)
            // Exact height, and **clipped**. Every row is one line of text, so nothing about the
            // height should be emergent — and the selected row's fill was reaching a good 30pt
            // above its own row, up over the reserved strip, which is what made the first scope
            // look like it had a grey block welded to the top of the window.
            .frame(height: 22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? Theme.surface3 : Color.clear)
            // The active bar is an **overlay**, not a sibling. As a sibling in the HStack, a
            // `Rectangle().frame(width: 2)` has only its width constrained — a shape is
            // infinitely flexible on the free axis, so it claimed every available point of
            // height and stretched each row to ~200pt. An overlay is bounded by the row it
            // sits on, so the text decides the height and the bar follows.
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(active ? (option.tint ?? Theme.working) : Color.clear)
                    .frame(width: 2)
            }
            // Clipped, because the selected row's fill was reaching ~30pt above its own row and
            // I could not identify what was drawing it. This makes the question moot: whatever
            // the row draws, it cannot escape the row.
            .clipped()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
        .help(option.help)
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
        .background(ThinScrollers())
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

            // Only when there is something unmerged. Since the lock now covers a settled
            // sequence too, an unguarded header would read "CONFLICTED 0" over an empty list.
            if session.hasConflicts {
                Text("CONFLICTED \(session.mergeFiles.count)")
                    .font(.ui(10, .semibold)).foregroundStyle(Theme.error)
                    .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)

                ForEach(session.mergeFiles, id: \.path) { file in
                    conflictRow(file)
                }
            } else if session.mergeState.isActive {
                Text("Everything is resolved — continue when you're ready.")
                    .font(.ui(10.5)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12).padding(.top, 8)
            }

            if session.mergeState.isActive {
                sequenceMessageBox
                continueRow
                abortRow
            }
            // `.loose` — unmerged files with nothing in flight. No Continue and no Abort,
            // because there is nothing to continue or abort; a disabled Continue reading
            // "nothing in progress" beside a locked workbench is a contradiction the user
            // would otherwise have to resolve on our behalf.
            if case .loose = session.conflictContext {
                looseConflictPanel
            }
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
    /// Finish the stopped step, or abandon the operation.
    ///
    /// Continue is what closes the loop: before this, a rebase resolved in the workbench sat
    /// half-applied until you went back to the terminal, because nothing here ran
    /// `--continue`.
    private var continueRow: some View {
        let reason = SequencePolicy.blockedReason(isActive: session.mergeState.isActive,
                                                 unresolved: session.totalUnresolved,
                                                 writing: session.writing)
        return HStack(spacing: 8) {
            Button { session.continueOperation() } label: {
                Text("Continue \(abortVerb)")
                    .font(.ui(10, .medium))
                    .foregroundStyle(reason == nil ? Theme.textPrimary : Theme.textDim)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    // The diff palette's green, not the agent-state one: `Theme.Diff` exists
                    // precisely to keep "an addition" and "an agent is done" apart.
                    .background((reason == nil ? Color(hex: Theme.Diff.addition) : Theme.textDim)
                        .opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false).disabled(reason != nil)
            .help(reason ?? "Commit this step and carry on with the \(abortVerb)")
            // A disabled button always says why — never a dead control.
            if let reason {
                Text(reason).font(.ui(9.5)).foregroundStyle(Theme.textDim)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.top, 10)
    }

    /// The message git is about to commit, editable.
    ///
    /// Shown only when a commit is actually pending: a rebase stopped on `break` has no message
    /// file, and an empty box there would imply one.
    @ViewBuilder private var sequenceMessageBox: some View {
        if session.pendingSequenceMessage != nil {
            VStack(alignment: .leading, spacing: 3) {
                TextEditor(text: $session.sequenceMessageDraft)
                    .font(.mono(10))
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(Theme.textPrimary)
                    .frame(height: 44)
                    .padding(.horizontal, 5).padding(.vertical, 4)
                    .background(Theme.surface2)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Text("edit to reword this commit")
                    .font(.ui(9)).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 12).padding(.top, 8)
        }
    }

    /// Conflicts with no operation behind them, and the one way out.
    ///
    /// The explanation is on screen rather than in a tooltip: the workbench is locked, which
    /// implies a sequence, and the user has no other way to learn there isn't one.
    private var looseConflictPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10)).foregroundStyle(Theme.blocked)
                Text(SequencePolicy.looseHeadline(unresolved: session.totalUnresolved))
                    .font(.ui(10.5, .semibold)).foregroundStyle(Theme.blocked)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            Text(SequencePolicy.looseExplanation)
                .font(.ui(9.5)).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 0) {
                Button(role: .destructive) { discardConfirm = true } label: {
                    Text("Discard changes…")
                        .font(.ui(10, .medium)).foregroundStyle(Theme.error)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.error.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false).disabled(session.writing)
                .help("Restore the conflicted files to HEAD")
                Spacer(minLength: 0)
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 12).padding(.top, 10)
    }

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
                breadcrumbTrail
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
        .background(ThinScrollers())
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
    /// Forces the enclosing scroll view to macOS's **thin overlay** scroller.
    ///
    /// With "Show scroll bars: Always" set system-wide, AppKit gives every scroll view the
    /// *legacy* scroller — a permanently visible bar wide enough to read as a UI column of its
    /// own, which in a 260pt rail is a real cost. Overlay scrollers are the thin
    /// auto-hiding kind. Set per scroll view, so it does not fight the user's global preference
    /// anywhere else.
    ///
    /// Deferred to the next runloop turn because the SwiftUI `ScrollView` has not attached this
    /// background view to its `NSScrollView` ancestor yet during `updateNSView`.
    private struct ThinScrollers: NSViewRepresentable {
        func makeNSView(context: Context) -> NSView { NSView(frame: .zero) }

        func updateNSView(_ view: NSView, context: Context) {
            // Retried: the ancestor `NSScrollView` does not exist yet on the first pass, and a
            // single deferred attempt was landing too early — the scrollers stayed legacy-thick.
            apply(from: view, attemptsLeft: 6)
        }

        private func apply(from view: NSView, attemptsLeft: Int) {
            var ancestor = view.superview
            while let current = ancestor, !(current is NSScrollView) {
                ancestor = current.superview
            }
            guard let scrollView = ancestor as? NSScrollView else {
                guard attemptsLeft > 0 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    apply(from: view, attemptsLeft: attemptsLeft - 1)
                }
                return
            }
            scrollView.scrollerStyle = .overlay
            scrollView.autohidesScrollers = true
            // Belt as well as braces: AppKit re-asserts the *system* scroller style on its own
            // notifications, and a legacy scroller at least gets narrower at a smaller control
            // size rather than staying a 15pt column.
            scrollView.verticalScroller?.controlSize = .small
            scrollView.horizontalScroller?.controlSize = .small
        }
    }

    /// One breadcrumb trail instead of a stack of back-rows.
    ///
    /// Drilling into a commit and then into a file used to produce two separate rows — a
    /// `‹ COMMITS <sha>` above a `‹ All 3 files` — each an independent way back up one level.
    /// A trail says the same thing in one line and makes the hierarchy visible rather than
    /// implied: every segment but the last is a button that pops to that level.
    @ViewBuilder private var breadcrumbTrail: some View {
        let crumbs = breadcrumbs
        if crumbs.count > 1 {
            HStack(spacing: 4) {
                ForEach(Array(crumbs.enumerated()), id: \.offset) { index, crumb in
                    if index > 0 {
                        Text("‹").font(.ui(10)).foregroundStyle(Theme.textDim)
                    }
                    // The last crumb is where you already are, so it is a label, not a control.
                    if let pop = crumb.pop {
                        Button(action: pop) {
                            Text(crumb.title)
                                .font(.ui(11)).foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).focusable(false)
                        .help("Back to \(crumb.title)")
                    } else {
                        Text(crumb.title)
                            .font(.ui(11, .semibold)).foregroundStyle(Theme.textPrimary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 5)
        }
    }

    private struct Crumb {
        let title: String
        /// nil for the crumb you are standing on.
        let pop: (() -> Void)?
    }

    /// Root → commit → file, with only the levels that currently exist.
    private var breadcrumbs: [Crumb] {
        var crumbs: [Crumb] = []
        if session.scope == .commits {
            if let commit = session.selectedCommit {
                crumbs.append(Crumb(title: "Commits") { session.selectCommit(nil) })
                crumbs.append(Crumb(title: commit.shortSha,
                                    pop: session.focusedFile == nil ? nil
                                                                    : { session.focus(file: nil) }))
            }
        } else {
            crumbs.append(Crumb(title: "All \(uniqueFileCount) files",
                                pop: session.focusedFile == nil ? nil
                                                                : { session.focus(file: nil) }))
        }
        if let focused = session.focusedFile {
            crumbs.append(Crumb(title: (focused as NSString).lastPathComponent, pop: nil))
        }
        return crumbs
    }

    /// Where a listed file stands relative to the index. `committed` exists because
    /// vs-base mode lists everything changed since the base branch, most of which is
    /// already committed — calling those "unstaged" was a lie, and the stage button on
    /// them ran a `git add` that succeeded while moving nothing.
    private enum SectionKind {
        case staged, unstaged, committed, inCommit

        var title: String {
            switch self {
            case .staged:    return "STAGED"
            case .unstaged:  return "UNSTAGED"
            case .committed: return "COMMITTED"
            case .inCommit:  return "FILES"
            }
        }
        /// nil ⇒ no bulk action; the files can't move.
        var bulkAction: (title: String, staged: Bool)? {
            switch self {
            case .staged:    return ("Unstage all", false)
            case .unstaged:  return ("Stage all", true)
            // Nothing in history can be staged, so no row under it gets a button — the same
            // rule as Committed, for the same reason.
            case .committed, .inCommit: return nil
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
        // A commit's files are one list: the staged/unstaged/committed split describes where a
        // change sits relative to the index, and history sits nowhere relative to it.
        if session.selectedCommit != nil {
            let files = scopedFiles
            guard !files.isEmpty else { return [] }
            return [FileSection(kind: .inCommit, groups: byDirectory(files))]
        }
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
        case .staged:              return Color(hex: Theme.Diff.addition)
        case .unstaged:            return Theme.textSecondary
        case .committed, .inCommit: return Theme.textDim
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
            // Without this the row gets macOS's default bordered button style: a rounded bezel
            // around every filename, with its label **centred**, which is what pushed the
            // status glyphs out of line. The stage button beside it always had `.plain`, so only
            // this one showed it.
            .buttonStyle(.plain).focusable(false)
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
