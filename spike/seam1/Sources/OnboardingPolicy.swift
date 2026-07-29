import Foundation

/// What a step needs in order to be worth showing. Two independent axes: whether the
/// scratch repo exists, and whether a real Claude session can be started in it.
struct OnboardingRequirement: OptionSet, Equatable {
    let rawValue: Int
    static let sandbox   = OnboardingRequirement(rawValue: 1 << 0)
    static let liveAgent = OnboardingRequirement(rawValue: 1 << 1)
}

/// A real UI element a card can point an arrow at. `.centered` means no arrow.
/// Indices are into the demo workspace only.
enum OnboardingAnchor: Hashable {
    case centered
    case terminalArea
    case folderHeader
    case tabRow(Int)
    case stateDot(Int)
    case ephemeralPane
    case workbenchRail
    case workbenchBuffer
    case shortcutCheatsheet
    case sidebarFooter
}

/// The side effect a step performs when it becomes current. A step with `.none` either
/// describes what is already on screen or invites the user to try the keystroke itself
/// — typing into the buffer for them would prove nothing.
enum OnboardingAction: Equatable {
    case none
    case buildSandbox
    case createDemoWorkspace
    case startConflictMerge
    case teardown
}

struct Preflight: Equatable {
    var claudePath: String?
    var pluginInstalled: Bool
    var gitAvailable: Bool
    var sandboxBuilt: Bool

    var liveAgentPossible: Bool { claudePath != nil && pluginInstalled }

    var available: OnboardingRequirement {
        var r: OnboardingRequirement = []
        if gitAvailable && sandboxBuilt { r.insert(.sandbox) }
        if liveAgentPossible { r.insert(.liveAgent) }
        return r
    }
}

struct OnboardingStep: Identifiable, Equatable {
    let id: String
    let title: String
    let body: String
    /// The imperative shown next to a live tick, e.g. "Press ⌘D". Empty for a step with
    /// nothing to do.
    var instruction: String = ""
    let anchor: OnboardingAnchor
    var action: OnboardingAction = .none
    /// Gates Next. The user performs it; the tour only watches.
    var goal: OnboardingGoal = .none
    let requires: OnboardingRequirement
}

enum OnboardingPolicy {

    static let script: [OnboardingStep] = [
        OnboardingStep(
            id: "welcome",
            title: "Welcome to Shepherd",
            body: "Shepherd is a terminal that treats Claude Code sessions as tracked agents. "
                + "Two things to set up, then a hands-on tour in a throwaway sandbox — you'll "
                + "drive, and each card waits until you've done the thing.",
            anchor: .centered, action: .buildSandbox, requires: []),

        OnboardingStep(
            id: "terminal",
            title: "It's a terminal first",
            body: "A real shell on a real grid — mouse, scroll, selection and copy/paste all "
                + "behave the way you expect. This workspace and its scratch git repo were made "
                + "for the tour and get deleted at the end, so break anything you like.",
            anchor: .terminalArea, action: .createDemoWorkspace, requires: [.sandbox]),

        OnboardingStep(
            id: "sidebar",
            title: "The sidebar is your agent list",
            body: "Tabs take their name from their directory and group into workspace folders. "
                + "⌃⇥ cycles workspaces; ⌘⇧[ and ⌘⇧] move between tabs; ⌘⇧N makes a workspace.",
            anchor: .folderHeader, requires: [.sandbox]),

        OnboardingStep(
            id: "split",
            title: "Each pane is its own agent",
            body: "A tab holds a tree of panes, and every pane is tracked separately. ⌘⇧D stacks "
                + "instead of side-by-side, ⌘⇧↩ zooms one, ⌘⌥ plus an arrow moves focus.",
            instruction: "Press ⌘D to split this tab",
            anchor: .terminalArea, goal: .splitPane, requires: [.sandbox]),

        OnboardingStep(
            id: "unsplit",
            title: "And ⌘W closes one",
            body: "⌘W closes the focused pane, then the tab once it's the last pane, then leaves "
                + "the workspace empty rather than deleting it.",
            instruction: "Press ⌘W to close the pane you just made",
            anchor: .terminalArea, goal: .unsplitPane, requires: [.sandbox]),

        OnboardingStep(
            id: "ephemeral",
            title: "⌘⌥N is a scratch shell",
            body: "An ephemeral pane floats over your work and belongs to no tab. Esc tucks it "
                + "into a thumbnail, clicking that brings it back, ⌘W throws it away. Good for "
                + "the one-off command you don't want a tab for.",
            instruction: "Press ⌘⌥N",
            anchor: .ephemeralPane, goal: .ephemeralOpen, requires: []),

        OnboardingStep(
            id: "agentStart",
            title: "Now start an agent",
            body: "Run Claude Code in this pane like you normally would. The dot in the sidebar "
                + "will light up the moment it does — that's a lifecycle hook reporting in. Panes "
                + "are matched by an env var injected into the shell, never by guessing at "
                + "process trees.",
            instruction: "Type  claude  in the pane and hit return",
            anchor: .tabRow(0), goal: .agentRunning, requires: [.sandbox, .liveAgent]),

        OnboardingStep(
            id: "agentWatched",
            title: "Watch a turn go by",
            body: "Amber is working. When it finishes while you're looking straight at it, it "
                + "settles to plain idle rather than done — you already saw it, so there's "
                + "nothing left to tell you.",
            instruction: "Ask it anything, and watch the dot",
            anchor: .tabRow(0), goal: .turnFinished, requires: [.sandbox, .liveAgent]),

        OnboardingStep(
            id: "agentUnwatched",
            title: "Now do it without looking",
            body: "Same agent, same prompt — but this time the turn ends while you're elsewhere, "
                + "so it lands as done, with a dock badge and a notification. ⌘⇧A jumps to "
                + "whoever needs you next, across every workspace. This is the whole point of "
                + "the app.",
            instruction: "Ask it something, then switch to another tab before it answers",
            anchor: .tabRow(0), goal: .turnFinishedAway, requires: [.sandbox, .liveAgent]),

        OnboardingStep(
            id: "workbench",
            title: "⌘G opens the workbench",
            body: "Review what an agent changed without leaving the terminal. The rail splits into "
                + "staged, unstaged and committed; ⌃1–⌃4 switch between the working tree, a diff "
                + "against the base branch, files, and this branch's commits.",
            instruction: "Press ⌘G",
            anchor: .workbenchRail, goal: .workbenchOpen, requires: [.sandbox]),

        OnboardingStep(
            id: "workbenchStage",
            title: "Stage lines, not just files",
            body: "Selection *is* the text selection — there's no checkbox column. ⌘⌥⏎ takes it "
                + "back out again. Removed lines are drawn as bands rather than rows, and staging "
                + "a hunk takes its deletions with it.",
            instruction: "Drag over some changed lines, then press ⌘⏎",
            anchor: .workbenchBuffer, goal: .stagedSomething, requires: [.sandbox]),

        OnboardingStep(
            id: "workbenchEdit",
            title: "The diff is editable",
            body: "This is the real file, not a preview — ⌘S writes it to disk. ⌘P opens any file "
                + "in the repo whole, ⌥⌘\\ splits the view old-beside-new, ⌥↓ and ⌥↑ jump "
                + "between hunks.",
            instruction: "Click in the code and type something",
            anchor: .workbenchBuffer, goal: .bufferDirty, requires: [.sandbox]),

        OnboardingStep(
            id: "workbenchComment",
            title: "⌘⇧C leaves a note for the agent",
            body: "Comments anchor to the line and batch up; sending the batch hands the agent "
                + "your review as a prompt. Yours are blue. A pull request's own review threads "
                + "land here too, in violet, with reply and resolve.",
            instruction: "Put the cursor on a line and press ⌘⇧C",
            anchor: .workbenchBuffer, goal: .commented, requires: [.sandbox]),

        OnboardingStep(
            id: "workbenchCommits",
            title: "⌃4 — this branch's commits",
            body: "Just the base..HEAD range, so it's linear and there's no graph to read. Click a "
                + "commit to narrow the rail to its files. With the buffer on a single file the "
                + "gutter grows a blame lane — age by shade; click a cell to open that commit.",
            instruction: "Press ⌃4",
            anchor: .workbenchRail, goal: .commitsScope, requires: [.sandbox]),

        OnboardingStep(
            id: "worktree",
            title: "One branch, one directory, one agent",
            body: "Shepherd runs git worktree add for you and opens a tab in it, so two agents "
                + "never fight over one checkout. Closing a worktree tab offers to archive your "
                + "uncommitted work instead of losing it; archives expire after 90 days.",
            instruction: "Hover the Shepherd Tour folder, hit +, then New Worktree Tab…",
            anchor: .folderHeader, goal: .worktreeTab, requires: [.sandbox]),

        OnboardingStep(
            id: "conflict",
            title: "A conflict makes this the resolver",
            body: "Shepherd just started a merge in that worktree, and it conflicted — so the "
                + "workbench locks to one scope until it's settled. Both sides come from git's "
                + "index, and each is labelled with its real branch name: mid-rebase \"ours\" is "
                + "the branch you're landing on, so the word is never used. Accept a side and the "
                + "markers go.",
            anchor: .workbenchRail, action: .startConflictMerge, requires: [.sandbox]),

        OnboardingStep(
            id: "prStatus",
            title: "Pull requests, once there's a remote",
            body: "With the gh CLI and a real GitHub remote, an idle agent's dot becomes its PR's "
                + "status — merged, open, checks pending, failing — and clicking it opens the PR. "
                + "Unresolved review threads badge it with a count. This sandbox's remote is a "
                + "local directory, so there's nothing to show you here.",
            anchor: .folderHeader, requires: []),

        OnboardingStep(
            id: "shortcuts",
            title: "⌘/ lists every keybinding",
            body: "Everything the app can do, on one card, generated from the same catalogue the "
                + "menu bar is — so the two can't drift. Esc or ⌘/ again closes it. The workbench "
                + "keys only bind while the workbench is open, so they're listed here rather than "
                + "stealing keystrokes from your shell.",
            instruction: "Press ⌘/",
            anchor: .shortcutCheatsheet, goal: .cheatsheetOpen, requires: []),

        OnboardingStep(
            id: "rest",
            title: "That's the tour",
            body: "⌘, opens Settings — theme, font, worktree hooks, keep-awake, pairing a phone. "
                + "Updates arrive as a pill down here. And agents keep running while you're in "
                + "another app; that's the point.",
            anchor: .sidebarFooter, requires: []),

        OnboardingStep(
            id: "done",
            title: "Sandbox going away",
            body: "Removing it now — the workspace, its tabs, the worktree and the scratch repo all "
                + "go, and nothing you did in there is kept. Open a directory of your own and "
                + "start an agent. Help → Shepherd Tour replays this any time.",
            anchor: .centered, action: .teardown, requires: []),
    ]

    /// Shown in place of the three live-agent steps when Claude Code or the plugin is absent.
    static let agentLegendCard = OnboardingStep(
        id: "agentLegend",
        title: "Agent states need Claude Code",
        body: "The live demo needs both the claude CLI on your PATH and Shepherd's plugin "
              + "installed, so it's skipped. For reference, a pane's dot reads: grey shell, "
              + "amber working, red blocked and waiting on you, green done, plain idle.",
        anchor: .stateDot(0), requires: [.sandbox])

    /// Shown when the scratch repo could not be created — everything needing a repo is gone.
    static let noSandboxCard = OnboardingStep(
        id: "noSandbox",
        title: "No sandbox this time",
        body: "Shepherd couldn't create its scratch git repository, so the hands-on steps are "
              + "skipped. Everything below still applies to a directory of your own.",
        anchor: .centered, action: .none, requires: [])

    static func steps(for p: Preflight) -> [OnboardingStep] {
        let avail = p.available
        var out = script.filter { $0.requires.isSubset(of: avail) }

        // A missing sandbox already removed the agent steps; only one card should
        // explain the absence.
        if !avail.contains(.sandbox) {
            out.insert(noSandboxCard, at: 1)
        } else if !avail.contains(.liveAgent) {
            out.insert(agentLegendCard, at: firstLiveAgentSlot(surviving: out))
        }
        return out
    }

    /// Where the dropped live-agent steps used to begin: the number of steps that both
    /// precede the first one in the script *and* survived filtering. Derived rather
    /// than pinned to a neighbour's id, so inserting a step never silently moves it.
    private static func firstLiveAgentSlot(surviving: [OnboardingStep]) -> Int {
        guard let first = script.firstIndex(where: { $0.requires.contains(.liveAgent) })
        else { return surviving.count }
        let before = Set(script[..<first].map(\.id))
        return surviving.filter { before.contains($0.id) }.count
    }
}
