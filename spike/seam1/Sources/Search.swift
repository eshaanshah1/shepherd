import Foundation

/// Transient per-pane terminal-search state. libghostty's core does the matching
/// (literal, case-insensitive substring) and highlights the grid itself; this only
/// holds the query and the match counts the core reports back. Not persisted.
struct SearchState: Equatable {
    var query: String = ""
    /// Total matches reported by the core (`SEARCH_TOTAL`).
    var total: Int = 0
    /// 1-based index of the current match, for display; 0 = none selected.
    var selected: Int = 0
    /// A needle was sent that nothing has been selected for yet.
    var awaitingSeek = false

    /// "3/12" for the overlay; empty while no query is entered.
    var counter: String {
        guard !query.isEmpty else { return "" }
        return "\(selected)/\(total)"
    }

    /// A non-empty query the core found nothing for.
    var noMatches: Bool { !query.isEmpty && total == 0 }

    /// A new needle: the old counts and selection are stale, and the core will
    /// need a nudge before it lands on a match.
    mutating func beginQuery(_ q: String) {
        query = q
        total = 0
        selected = 0
        awaitingSeek = !q.isEmpty
    }

    mutating func applyTotal(_ raw: Int) { total = max(0, raw) }

    /// `SEARCH_SELECTED` carries the core's 0-based match index, `-1` for none.
    mutating func applySelected(_ raw: Int) {
        selected = raw < 0 ? 0 : raw + 1
        if selected > 0 { awaitingSeek = false }
    }

    /// Whether the core should be asked to navigate now. Changing the needle only
    /// highlights matches — the core selects one (and scrolls it into view) solely
    /// in response to `navigate_search` — so a fresh needle with matches needs one.
    mutating func takeSeek() -> Bool {
        guard awaitingSeek, total > 0 else { return false }
        awaitingSeek = false
        return true
    }
}

enum SearchDirection: String {
    case next
    case previous
}
