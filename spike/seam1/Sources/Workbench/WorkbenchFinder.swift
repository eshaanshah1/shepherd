import SwiftUI

/// `⌘P` — fuzzy-open any file in the repo, not just the changed ones.
///
/// This is where the workbench stops being diff-only: an opened file becomes a `.context`
/// excerpt covering the whole file, which is the same mechanism a revealed hunk gap uses.
struct WorkbenchFinder: View {
    @ObservedObject var session: WorkbenchSession
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var fieldFocused: Bool

    private var matches: [FileMatch] {
        FileFinder.rank(session.repoFiles, query: query, limit: 40)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.35)
                .contentShape(Rectangle())
                .onTapGesture { session.finderOpen = false }

            VStack(spacing: 0) {
                field
                if !matches.isEmpty {
                    Rectangle().fill(Theme.hairline).frame(height: 1)
                    results
                }
            }
            .frame(width: 520)
            .background(Theme.surface2)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(0.4), radius: 24, y: 8)
            .padding(.top, 90)

            keys
        }
        .onAppear { fieldFocused = true }
    }

    private var field: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12)).foregroundStyle(Theme.textDim)
            TextField("Open file…", text: $query)
                .textFieldStyle(.plain)
                .font(.ui(13))
                .foregroundStyle(Theme.textPrimary)
                .focused($fieldFocused)
                .onSubmit(open)
                .onChange(of: query) { _ in selection = 0 }
            if session.repoFiles.isEmpty {
                Text("reading…").font(.ui(10)).foregroundStyle(Theme.textDim)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    private var results: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(matches.enumerated()), id: \.element.path) { index, match in
                    row(match, selected: index == selection)
                        .onTapGesture {
                            selection = index
                            open()
                        }
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxHeight: 320)
    }

    private func row(_ match: FileMatch, selected: Bool) -> some View {
        let name = (match.path as NSString).lastPathComponent
        let directory = (match.path as NSString).deletingLastPathComponent
        return HStack(spacing: 6) {
            Text(name).font(.ui(12, selected ? .semibold : .regular))
                .foregroundStyle(Theme.textPrimary).lineLimit(1)
            // Head-truncated: the tail of a deep path is the part that identifies it.
            Text(directory).font(.ui(10))
                .foregroundStyle(Theme.textDim)
                .lineLimit(1).truncationMode(.head)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Theme.surface3 : Color.clear)
        .contentShape(Rectangle())
    }

    /// Arrow keys and Esc as zero-sized buttons, the same trick the rest of the workbench
    /// uses — a menu key equivalent would outrank the text field.
    @ViewBuilder private var keys: some View {
        Group {
            Button("") { move(by: 1) }.keyboardShortcut(.downArrow, modifiers: [])
            Button("") { move(by: -1) }.keyboardShortcut(.upArrow, modifiers: [])
            Button("") { session.finderOpen = false }.keyboardShortcut(.cancelAction)
        }
        .opacity(0).frame(width: 0, height: 0).focusable(false)
    }

    private func move(by delta: Int) {
        guard !matches.isEmpty else { return }
        selection = min(max(0, selection + delta), matches.count - 1)
    }

    private func open() {
        guard matches.indices.contains(selection) else { return }
        session.openFile(path: matches[selection].path)
    }
}
