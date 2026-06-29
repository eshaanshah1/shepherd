import Foundation

/// The libghostty surface `command` for a pane, given whether this machine is
/// serving. When serving, panes run through the bundled `shepherdd pty` wrapper
/// (so their PTY is ours to stream later); otherwise libghostty forks the shell
/// itself and we return nil (no override).
///
/// `helperPath` is assumed free of spaces (it lives in the app bundle). If that
/// ever changes, switch the wiring to libghostty's `initial_input` handshake.
func remoteSurfaceCommand(serving: Bool, helperPath: String) -> String? {
    serving ? "\(helperPath) pty" : nil
}
