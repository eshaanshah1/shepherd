import Foundation

/// Transient per-pane terminal-search state. libghostty's core does the matching
/// (literal, case-insensitive substring) and highlights the grid itself; this only
/// holds the query and the match counts the core reports back. Not persisted.
struct SearchState: Equatable {
    var query: String = ""
    /// Total matches reported by the core (`SEARCH_TOTAL`).
    var total: Int = 0
    /// 1-based index of the current match (`SEARCH_SELECTED`); 0 = none.
    var selected: Int = 0

    /// "3/12" for the overlay; empty while no query is entered.
    var counter: String {
        guard !query.isEmpty else { return "" }
        return "\(selected)/\(total)"
    }

    /// A non-empty query the core found nothing for.
    var noMatches: Bool { !query.isEmpty && total == 0 }
}

enum SearchDirection: String {
    case next
    case previous
}
