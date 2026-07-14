import Foundation

/// State of the code surface overlay. Pure model (no AppKit).
/// Edit mode is a mini-editor: a file tree rooted at `rootPath`, a set of open
/// files shown as tabs, and one `activeFile`.
struct CodeSurfaceState: Equatable {
    enum Mode: Equatable { case edit, diff }

    var mode: Mode = .edit
    var targetPaneID: String?
    var rootPath: String?
    var openFiles: [String] = []
    var activeFile: String?
    var dirty: Set<String> = []

    static func editing(root: String?, pane: String?) -> CodeSurfaceState {
        CodeSurfaceState(mode: .edit, targetPaneID: pane, rootPath: root)
    }

    /// Open (or focus) a file as the active tab.
    mutating func open(_ path: String) {
        if !openFiles.contains(path) { openFiles.append(path) }
        activeFile = path
    }

    /// Close a tab; activate its neighbor (next, else previous, else none).
    mutating func close(_ path: String) {
        guard let idx = openFiles.firstIndex(of: path) else { return }
        openFiles.remove(at: idx)
        dirty.remove(path)
        if activeFile == path {
            if openFiles.isEmpty { activeFile = nil }
            else { activeFile = openFiles[min(idx, openFiles.count - 1)] }
        }
    }

    mutating func markDirty(_ path: String) { dirty.insert(path) }
    mutating func clearDirty(_ path: String) { dirty.remove(path) }
    func isDirty(_ path: String) -> Bool { dirty.contains(path) }

    func displayName(_ path: String) -> String { (path as NSString).lastPathComponent }
}
