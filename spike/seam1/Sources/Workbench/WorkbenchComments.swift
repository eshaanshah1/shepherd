import SwiftUI

/// The comment composer, anchored to a diff line.
///
/// Borrows GitHub's inline-comment *pattern* in Shepherd's idiom: a quiet card, no
/// avatar or markdown chrome. Carried over from the old review panel; W1 shows it as a
/// centered card rather than inline under the row, because anchoring overlays to a
/// live text fragment is the `WidgetLayer` work still ahead.
struct CommentComposer: View {
    let file: String
    let line: Int
    let side: DiffSide
    let onSubmit: (String) -> Void
    let onCancel: () -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Comment on").font(.ui(13, .semibold)).foregroundStyle(Theme.textPrimary)
                Text("\(file):\(sideLetter)\(line)")
                    .font(.mono(12, .medium)).foregroundStyle(Theme.textSecondary)
                Spacer()
            }

            ZStack(alignment: .topLeading) {
                TextEditor(text: $text)
                    .font(.ui(12))
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .frame(height: 92)
                if empty {
                    Text("Leave a note for the agent…")
                        .font(.ui(12)).foregroundStyle(Theme.textDim)
                        .padding(.leading, 5).allowsHitTesting(false)
                }
            }

            HStack(spacing: 6) {
                Spacer()
                Button(action: onCancel) {
                    Text("Cancel").font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 3).contentShape(Rectangle())
                }
                .buttonStyle(.plain).focusable(false)
                Button {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { onSubmit(trimmed) }
                } label: {
                    Text("Comment").font(.ui(11, .semibold))
                        .foregroundStyle(empty ? Theme.textDim : Theme.textPrimary)
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(empty ? Color.clear : Theme.surface3)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(empty).focusable(false)
            }
        }
        .padding(12)
        .frame(width: 440, alignment: .leading)
        .shepherdCard()
        .onAppear { focused = true }
    }

    private var sideLetter: String { side == .new ? "R" : "L" }
}

/// A pending comment in the rail's outgoing batch. Hover reveals its remove button.
struct CommentBubble: View {
    let comment: ReviewComment
    let onRemove: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                if let author = comment.githubAuthor {
                    TablerIcon(paths: Tabler.brandGithub, size: 11).foregroundStyle(Theme.prMerged)
                    Text("@\(author)").font(.ui(10, .semibold)).foregroundStyle(Theme.prMerged)
                }
                Text("\((comment.file as NSString).lastPathComponent):\(comment.line)")
                    .font(.mono(10)).foregroundStyle(Theme.textDim).lineLimit(1)
                Spacer(minLength: 2)
                if hovering {
                    Button(action: onRemove) {
                        TablerIcon(paths: Tabler.x, size: 9).foregroundStyle(Theme.textDim)
                    }
                    .buttonStyle(.plain).focusable(false)
                }
            }
            Text(comment.text).font(.ui(11)).foregroundStyle(Theme.textPrimary)
                .lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(comment.githubAuthor == nil ? Theme.surface2 : Theme.prMerged.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .onHover { hovering = $0 }
    }
}
