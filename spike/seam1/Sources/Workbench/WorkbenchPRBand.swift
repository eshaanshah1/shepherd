import SwiftUI

/// The PR band under the workbench header: what the PR's state is, whether its checks
/// pass, and the two actions worth having here — review and merge.
///
/// Shown only when the pane's checkout actually has a PR, so a branch without one costs
/// no vertical space. Everything is gated on `GH.isInstalled` upstream, in `refreshPR`.
struct WorkbenchPRBand: View {
    @EnvironmentObject var store: AgentStore
    @ObservedObject var session: WorkbenchSession

    @State private var showChecks = false
    @State private var reviewing: PRReviewVerdict?
    @State private var mergeMethod: PRMergeMethod = .squash
    @State private var busy = false
    @State private var error: String?

    private var detail: PRDetail? { store.prDetails[session.paneID] }

    var body: some View {
        if let detail {
            VStack(spacing: 0) {
                summary(detail)
                if showChecks, !detail.checks.isEmpty {
                    Rectangle().fill(Theme.divider).frame(height: 1)
                    checksList(detail)
                }
                if let error {
                    Rectangle().fill(Theme.divider).frame(height: 1)
                    errorRow(error)
                }
            }
            .background(Theme.surface1)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
            .sheet(item: $reviewing) { verdict in
                PRReviewSheet(verdict: verdict) { body in
                    submitReview(verdict, body: body)
                }
            }
        }
    }

    // MARK: - Summary row

    private func summary(_ detail: PRDetail) -> some View {
        HStack(spacing: 8) {
            Button { NSWorkspace.shared.open(URL(string: detail.url)!) } label: {
                HStack(spacing: 5) {
                    TablerIcon(paths: Tabler.pullRequest, size: 12)
                    Text("#\(detail.number)").font(.mono(11, .medium))
                }
                .foregroundStyle(Theme.prMerged)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
            .help("Open on GitHub")

            Text(detail.title).font(.ui(12, .medium)).foregroundStyle(Theme.textPrimary)
                .lineLimit(1)

            if let state = stateLabel(detail) {
                chip(state.text, state.color)
            }

            // A merged or closed PR is history: its review decision and checks are stale
            // trivia, and showing "Approved · checks passing" with no state reads as
            // ready-to-merge. The state chip is the whole story.
            if !detail.isHistory {
                if let decision = reviewDecisionLabel(detail.reviewDecision) {
                    chip(decision.text, decision.color)
                }
                checksChip(detail)
            }

            Spacer(minLength: 8)

            if !detail.isHistory {
                actionButton("Approve", color: Color(hex: Theme.Diff.addition)) {
                    reviewing = .approve
                }
                actionButton("Request changes", color: Color(hex: Theme.Diff.deletion)) {
                    reviewing = .requestChanges
                }
                mergeButton(detail)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
    }

    /// Checks rollup — a chip that expands the list. Silent when the PR has no checks,
    /// rather than claiming "0 passing".
    @ViewBuilder private func checksChip(_ detail: PRDetail) -> some View {
        if let summary = detail.checksSummary {
            let color = checksColor(detail.rollup)
            Button { showChecks.toggle() } label: {
                HStack(spacing: 4) {
                    Image(systemName: showChecks ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                    Text(summary).font(.ui(10, .medium))
                }
                .foregroundStyle(color)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(color.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false)
        }
    }

    // MARK: - Checks list

    private func checksList(_ detail: PRDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Failures first — the reason you opened the list.
                ForEach(detail.checks.sorted { rank($0.verdict) < rank($1.verdict) }) { check in
                    checkRow(check)
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxHeight: 180)
    }

    private func checkRow(_ check: PRCheck) -> some View {
        Button {
            if let url = check.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 7) {
                Circle().fill(checksColor(check.verdict)).frame(width: 6, height: 6)
                Text(check.name).font(.ui(11)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Spacer(minLength: 4)
                if check.url != nil {
                    Image(systemName: "arrow.up.right.square")
                        .font(.system(size: 9)).foregroundStyle(Theme.textDim)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false)
        .disabled(check.url == nil)
        .help(check.url == nil ? check.name : "Open this run")
    }

    private func rank(_ verdict: ChecksVerdict) -> Int {
        switch verdict {
        case .failing: return 0
        case .pending: return 1
        case .passing: return 2
        case .none:    return 3
        }
    }

    // MARK: - Actions

    @ViewBuilder private func mergeButton(_ detail: PRDetail) -> some View {
        let blocked = detail.mergeability.reason
        let unknown = detail.mergeability == .unknown
        Menu {
            ForEach(PRMergeMethod.allCases, id: \.self) { method in
                Button(method.title) { merge(method) }
            }
        } label: {
            Text("Merge").font(.ui(11, .semibold))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(busy || blocked != nil || unknown)
        // Never a dead control: the disabled state says why GitHub won't take it.
        .help(blocked ?? (unknown ? "GitHub didn't report a merge state for this PR."
                                  : "Merge this PR"))
    }

    private func actionButton(_ title: String, color: Color,
                              _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.ui(11, .medium))
                .foregroundStyle(busy ? Theme.textDim : color)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(color.opacity(busy ? 0.05 : 0.12))
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).focusable(false).disabled(busy)
    }

    private func submitReview(_ verdict: PRReviewVerdict, body: String) {
        busy = true
        error = nil
        store.submitPRReview(verdict, body: body, forPane: session.paneID) { failure in
            busy = false
            error = failure
        }
    }

    private func merge(_ method: PRMergeMethod) {
        busy = true
        error = nil
        store.mergePR(method: method, deleteBranch: false, forPane: session.paneID) { failure in
            busy = false
            error = failure
        }
    }

    private func errorRow(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10)).foregroundStyle(Theme.error)
            Text(message).font(.mono(10)).foregroundStyle(Theme.error)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            GhostIconButton(systemName: "xmark", help: "Dismiss") { error = nil }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Theme.error.opacity(0.08))
    }

    // MARK: - Presentation

    private func chip(_ text: String, _ color: Color) -> some View {
        Text(text).font(.ui(10, .semibold)).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    /// The PR's own state. Nil for a plain open PR, where the review decision and checks
    /// already say everything and a redundant "Open" chip is just noise.
    private func stateLabel(_ detail: PRDetail) -> (text: String, color: Color)? {
        switch detail.state.uppercased() {
        case "MERGED": return ("Merged", Theme.prMerged)
        case "CLOSED": return ("Closed", Color(hex: Theme.Diff.deletion))
        default:       return detail.isDraft ? ("Draft", Theme.textDim) : nil
        }
    }

    private func reviewDecisionLabel(_ decision: String) -> (text: String, color: Color)? {
        switch decision.uppercased() {
        case "APPROVED":          return ("Approved", Color(hex: Theme.Diff.addition))
        case "CHANGES_REQUESTED": return ("Changes requested", Color(hex: Theme.Diff.deletion))
        case "REVIEW_REQUIRED":   return ("Review required", Theme.blocked)
        default:                  return nil
        }
    }

    private func checksColor(_ verdict: ChecksVerdict) -> Color {
        switch verdict {
        case .passing: return Color(hex: Theme.Diff.addition)
        case .failing: return Color(hex: Theme.Diff.deletion)
        case .pending: return Theme.blocked
        case .none:    return Theme.textDim
        }
    }
}

/// Body composer for a review. Approving with no comment is normal; requesting changes
/// or commenting without one is not, and `gh` rejects it — so the button gates on it.
private struct PRReviewSheet: View {
    let verdict: PRReviewVerdict
    let onSubmit: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var body_ = ""
    @FocusState private var focused: Bool

    private var title: String {
        verdict == .approve ? "Approve pull request" : "Request changes"
    }
    private var canSubmit: Bool {
        !verdict.requiresBody || !body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.ui(13, .semibold)).foregroundStyle(Theme.textPrimary)
            TextEditor(text: $body_)
                .font(.ui(12)).scrollContentBackground(.hidden).focused($focused)
                .frame(width: 380, height: 120)
                .padding(6)
                .background(Theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(alignment: .topLeading) {
                    if body_.isEmpty {
                        Text(verdict == .approve ? "Optional comment…" : "What needs changing?")
                            .font(.ui(12)).foregroundStyle(Theme.textDim)
                            .padding(.leading, 11).padding(.top, 10)
                            .allowsHitTesting(false)
                    }
                }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(verdict == .approve ? "Approve" : "Request changes") {
                    onSubmit(body_)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)
            }
        }
        .padding(14)
        .background(Theme.surface1)
        .onAppear { focused = true }
    }
}

extension PRReviewVerdict: Identifiable {
    var id: String { flag }
}
