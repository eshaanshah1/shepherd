import Foundation

/// What the user has to actually **do** before a step is satisfied. The tour tells them
/// the keystroke and waits; it does not press the key for them. `.none` is a step that
/// only has something to say.
enum OnboardingGoal: Equatable {
    case none
    case splitPane
    case unsplitPane
    case ephemeralOpen
    case agentRunning
    case turnFinished
    case turnFinishedAway
    case workbenchOpen
    case stagedSomething
    case bufferDirty
    case commented
    case commitsScope
    case worktreeTab
    case cheatsheetOpen
}

/// Everything the goals are judged against, lifted off the store into a plain value so the
/// judging is pure and testable. Counts rather than booleans where a baseline matters: the
/// sandbox ships with one file already staged, so "staged something" cannot mean "> 0".
struct TourProgress: Equatable {
    var demoPaneCount: Int = 0
    var demoTabCount: Int = 0
    var ephemeralOpen: Bool = false
    var agentRunning: Bool = false
    var turnFinishedWatched: Bool = false
    var turnFinishedAway: Bool = false
    var workbenchOpen: Bool = false
    var stagedCount: Int = 0
    var stagedBaseline: Int = 0
    var bufferDirty: Bool = false
    var commentCount: Int = 0
    var inCommitsScope: Bool = false
    var cheatsheetOpen: Bool = false
}

extension OnboardingGoal {
    func satisfied(by p: TourProgress) -> Bool {
        switch self {
        case .none:             return true
        case .splitPane:        return p.demoPaneCount >= 2
        case .unsplitPane:      return p.demoPaneCount == 1
        case .ephemeralOpen:    return p.ephemeralOpen
        case .agentRunning:     return p.agentRunning
        case .turnFinished:     return p.turnFinishedWatched || p.turnFinishedAway
        case .turnFinishedAway: return p.turnFinishedAway
        case .workbenchOpen:    return p.workbenchOpen
        case .stagedSomething:  return p.stagedCount > p.stagedBaseline
        case .bufferDirty:      return p.bufferDirty
        case .commented:        return p.commentCount > 0
        case .commitsScope:     return p.inCommitsScope
        case .worktreeTab:      return p.demoTabCount >= 2
        case .cheatsheetOpen:   return p.cheatsheetOpen
        }
    }
}
