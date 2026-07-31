import SwiftUI
import AppKit

struct ContentView: View {
    @EnvironmentObject var store: AgentStore
    @EnvironmentObject var onboarding: OnboardingController
    @AppStorage("shepherd.sidebarWidth") private var sidebarWidth: Double = 240
    // Live width while dragging the divider (nil when idle); committed
    // `sidebarWidth` lays out the terminal, so it's updated only on drop.
    @State private var dragWidth: Double?
    @State private var resizeStart: Double?

    private let minSidebar: Double = 180
    private let maxSidebar: Double = 440
    private let dividerWidth: Double = 6

    private var displayWidth: Double { dragWidth ?? sidebarWidth }

    /// A missing anchor degrades to a centred, arrow-less card — a view that forgot its
    /// `.onboardingAnchor`, or one that simply isn't mounted for this step, is a cosmetic
    /// regression rather than a crash. An empty rect counts as missing.
    ///
    /// Both ends measure in `OnboardingAnchorKey.space`, declared on this view, so the
    /// only correction needed is the reader's own offset within it (normally zero).
    private func spotRect(_ anchor: OnboardingAnchor,
                          _ anchors: [OnboardingAnchor: OnboardingSpot],
                          _ proxy: GeometryProxy) -> OnboardingSpot? {
        guard anchor != .centered, var spot = anchors[anchor], !spot.rect.isEmpty else { return nil }
        let named = proxy.frame(in: .named(OnboardingAnchorKey.space))
        spot.rect = spot.rect.offsetBy(dx: -named.origin.x, dy: -named.origin.y)
        // A full-height panel really does extend under the title bar (y = -32), so clip it
        // to what is on screen or the ring's top edge is drawn where nobody can see it.
        let visible = CGRect(origin: .zero, size: proxy.size)
        guard spot.rect.intersects(visible) else { return nil }
        spot.rect = spot.rect.intersection(visible)
        return spot
    }

    var body: some View {
        // Two layers so a divider drag never resizes the terminal mid-drag: the
        // terminal lays out against the committed `sidebarWidth`; the sidebar +
        // divider sit on top at the live `displayWidth`, the opaque sidebar
        // overflowing the terminal until the width commits on release.
        ZStack(alignment: .leading) {
            HStack(spacing: 0) {
                Color.clear.frame(width: sidebarWidth + dividerWidth)
                // The diff panel fully takes over the terminal area (slides in from the
                // trailing edge, opaque), rather than sharing width as a side panel.
                ZStack {
                    terminalArea
                    // Diff and editor are mutually exclusive full-takeover overlays.
                    // One opacity transition keeps open/close/swap calm (sliding both
                    // from the same edge crossed and looked janky).
                    if store.diffPanelOpen, let pid = store.diffPanelPaneID,
                       let session = store.workbenchSession(forPane: pid) {
                        WorkbenchView(session: session)
                            .environmentObject(store)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Theme.ground)
                            .transition(.opacity)
                    } else if let surface = store.codeSurface {
                        CodeSurfaceView(state: surface)
                            .environmentObject(store)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Theme.ground)
                            .transition(.opacity)
                    }
                }
            }

            HStack(spacing: 0) {
                SidebarView()
                    .frame(width: displayWidth)
                divider
            }

            EphemeralOverlayView()
                .environmentObject(store)
                .allowsHitTesting(!store.ephemeralPanes.isEmpty)
        }
        .background(Theme.ground)
        .animation(.easeOut(duration: 0.18),
                   value: store.diffPanelOpen ? 1 : (store.codeSurface != nil ? 2 : 0))
        .background(WindowLightsController().frame(width: 0, height: 0))
        .ignoresSafeArea()
        // Centered naming modal for a new workspace (+ button / ⌘⇧N).
        .overlay {
            if store.promptingNewWorkspace {
                NewWorkspaceModal(isPresented: $store.promptingNewWorkspace)
                    .environmentObject(store)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.promptingNewWorkspace)
        // The ⌘T composer (also the folder `+` and the empty-workspace button).
        .overlay {
            if store.promptingNewTab {
                NewTabComposer(isPresented: $store.promptingNewTab)
                    .environmentObject(store)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.promptingNewTab)
        // Tailnet device-discovery sheet (⋯ menu → "Add remote device…").
        .overlay {
            if store.showingRemoteDevices {
                RemoteDeviceSheet()
                    .environmentObject(store)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.showingRemoteDevices)
        // Phone-pairing QR sheet (⋯ menu → "Connect a phone…").
        .overlay {
            if store.showingPhonePairingQR {
                PhonePairingQRView()
                    .environmentObject(store)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.showingPhonePairingQR)
        // ⌘/ keyboard-shortcut cheatsheet.
        .overlay {
            if store.showShortcuts {
                ShortcutCheatsheetView(isPresented: $store.showShortcuts)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.showShortcuts)
        // Approval sheet when a remote device requests pairing — topmost, so it never
        // hides behind another sheet (e.g. the phone-pairing QR that triggered it).
        .overlay {
            if store.pendingApproval != nil {
                PairingApprovalView()
                    .environmentObject(store)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.pendingApproval != nil)
        // The first-run tour, above every sheet. Deliberately NOT part of isFrontPane's
        // full-takeover check: the terminal really is visible behind it, which is what
        // makes the watched-vs-unwatched steps honest rather than staged.
        //
        // The anchor reader has to be HERE, not inside the overlay: preferences travel up
        // from a view's own children, so a reader on the overlay sees only the overlay.
        // Attached last, so every sheet above is a descendant and can be pointed at too.
        .overlayPreferenceValue(OnboardingAnchorKey.self) { anchors in
            GeometryReader { proxy in
                if let step = onboarding.currentStep {
                    OnboardingOverlayView(step: step,
                                          spot: spotRect(step.anchor, anchors, proxy),
                                          container: proxy.size)
                        .environmentObject(onboarding)
                        .transition(.opacity)
                }
            }
        }
        .animation(.easeOut(duration: 0.16), value: onboarding.stepNumber)
        // Outside the reader as well as the publishers, so both resolve the same space.
        .coordinateSpace(name: OnboardingAnchorKey.space)
    }

    // Every workspace's surfaces stay mounted (background agents keep running);
    // only the current workspace's selected tab is visible. Flattened to one
    // tabID-keyed ForEach so a tab keeps its surface (live PTY) when dragged
    // between workspaces — grouping by workspace would re-parent and re-create it.
    private var terminalArea: some View {
        ZStack {
            Theme.ground
            ForEach(store.allMountedTabs, id: \.tab.tabID) { entry in
                SplitContainer(node: entry.tab.root,
                               tabID: entry.tab.tabID,
                               isTabSelected: entry.visible,
                               focusTick: store.focusTick,
                               zoomedPaneID: entry.tab.zoomedPaneID)
                    .opacity(entry.visible ? 1 : 0)
                    .allowsHitTesting(entry.visible)
            }
            if store.selectedTab == nil {
                WorkspaceEmptyView()
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeInOut(duration: 0.22), value: store.selectedWorkspaceID)  // cross-fade on switch
        .background(GeometryReader { geo in
            Color.clear
                .onAppear { store.lastContentSize = geo.size }
                .onChange(of: geo.size) { store.lastContentSize = $0 }
        })
    }

    // 1px hairline inside a draggable strip. The drag previews via `dragWidth`;
    // `sidebarWidth` (which lays out the terminal) commits only on release.
    private var divider: some View {
        ZStack {
            Rectangle().fill(Theme.hairline).frame(width: 1)
        }
        .frame(width: dividerWidth)
        .contentShape(Rectangle())
        .onHover { inside in
            if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
        }
        .gesture(
            DragGesture(minimumDistance: 1)
                .onChanged { v in
                    let base = resizeStart ?? sidebarWidth
                    resizeStart = base
                    dragWidth = min(maxSidebar, max(minSidebar, base + Double(v.translation.width)))
                }
                .onEnded { _ in
                    if let w = dragWidth { sidebarWidth = w }
                    dragWidth = nil
                    resizeStart = nil
                }
        )
    }
}
