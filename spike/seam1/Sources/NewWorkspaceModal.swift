import SwiftUI

/// Centered, on-brand modal for naming a new workspace — a self-drawn `Theme`
/// card over a dimmed backdrop (no native sheet/alert). The field autofocuses;
/// Enter (or Create) makes the workspace, Escape / Cancel / a backdrop click
/// dismisses. An empty name falls back to the default "Workspace N".
struct NewWorkspaceModal: View {
    @EnvironmentObject var store: AgentStore
    @Binding var isPresented: Bool

    @State private var name = ""
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ZStack {
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            VStack(alignment: .leading, spacing: 14) {
                Text("New Workspace")
                    .font(.ui(15, .semibold))
                    .foregroundStyle(Theme.textPrimary)

                TextField("Workspace name", text: $name)
                    .textFieldStyle(.plain)
                    .font(.ui(13))
                    .foregroundStyle(Theme.textPrimary)
                    .focused($fieldFocused)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .fill(Theme.raised)
                            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .strokeBorder(Theme.hairline, lineWidth: 1))
                    )
                    .onSubmit(create)
                    .onExitCommand { isPresented = false }

                HStack(spacing: 8) {
                    Spacer()
                    button("Cancel", weight: .medium, fg: Theme.textSecondary,
                           bg: Theme.raised) { isPresented = false }
                    button("Create", weight: .semibold, fg: Theme.textPrimary,
                           bg: Theme.working, action: create)
                }
            }
            .padding(18)
            .frame(width: 320)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.ground)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1))
            )
            .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
        }
        .onAppear { fieldFocused = true }
    }

    private func button(_ title: String, weight: Font.Weight, fg: Color, bg: Color,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.ui(12, weight))
                .foregroundStyle(fg)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(bg))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func create() {
        let id = store.newWorkspace()
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { store.renameWorkspace(id, to: trimmed) }
        isPresented = false
    }
}
