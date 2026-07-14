import SwiftUI

/// Sorted directory listing: directories first, then files, case-insensitive.
/// Skips `.git` and `.DS_Store`. FS access is here; the sort is pure.
enum FileTreeIO {
    static func children(of dir: String) -> [(name: String, isDir: Bool)] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        var out: [(String, Bool)] = []
        for name in names where name != ".git" && name != ".DS_Store" {
            var isDir: ObjCBool = false
            fm.fileExists(atPath: (dir as NSString).appendingPathComponent(name), isDirectory: &isDir)
            out.append((name, isDir.boolValue))
        }
        return sorted(out)
    }

    static func sorted(_ entries: [(String, Bool)]) -> [(name: String, isDir: Bool)] {
        entries.sorted { a, b in
            if a.1 != b.1 { return a.1 && !b.1 }
            return a.0.localizedCaseInsensitiveCompare(b.0) == .orderedAscending
        }.map { (name: $0.0, isDir: $0.1) }
    }
}

/// VSCode-style file explorer rooted at `root`. Custom ScrollView (not List) to
/// keep keyboard focus on the terminal (ADR 0009).
struct FileTreeView: View {
    let root: String
    var activeFile: String?
    var onOpen: (String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                DirectoryChildren(path: root, depth: 0, activeFile: activeFile, onOpen: onOpen)
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.surface1)
    }
}

private struct DirectoryChildren: View {
    let path: String
    let depth: Int
    var activeFile: String?
    var onOpen: (String) -> Void

    var body: some View {
        ForEach(FileTreeIO.children(of: path), id: \.name) { entry in
            let full = (path as NSString).appendingPathComponent(entry.name)
            if entry.isDir {
                DirectoryRow(name: entry.name, path: full, depth: depth, activeFile: activeFile, onOpen: onOpen)
            } else {
                FileRow(name: entry.name, path: full, depth: depth, isActive: full == activeFile, onOpen: onOpen)
            }
        }
    }
}

private struct DirectoryRow: View {
    let name: String
    let path: String
    let depth: Int
    var activeFile: String?
    var onOpen: (String) -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 4) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold)).foregroundColor(Theme.textDim).frame(width: 10)
                    Image(systemName: "folder").font(.system(size: 11)).foregroundColor(Theme.textSecondary)
                    Text(name).font(.system(size: 12)).foregroundColor(Theme.textPrimary).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.leading, CGFloat(depth) * 12 + 6).padding(.trailing, 6).padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            if expanded {
                DirectoryChildren(path: path, depth: depth + 1, activeFile: activeFile, onOpen: onOpen)
            }
        }
    }
}

private struct FileRow: View {
    let name: String
    let path: String
    let depth: Int
    let isActive: Bool
    var onOpen: (String) -> Void

    var body: some View {
        Button { onOpen(path) } label: {
            HStack(spacing: 4) {
                Color.clear.frame(width: 10)
                Image(systemName: "doc").font(.system(size: 11)).foregroundColor(Theme.textDim)
                Text(name).font(.system(size: 12))
                    .foregroundColor(isActive ? Theme.textPrimary : Theme.textSecondary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(depth) * 12 + 6).padding(.trailing, 6).padding(.vertical, 3)
            .background(isActive ? Theme.surface3 : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
    }
}
