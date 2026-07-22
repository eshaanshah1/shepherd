import SwiftUI
import CoreImage.CIFilterBuiltins

/// Self-drawn Theme sheet: a QR of this host's pairing payload for a phone to scan.
/// Styled like RemoteDeviceSheet. Backdrop-click / Esc dismiss.
struct PhonePairingQRView: View {
    @EnvironmentObject var store: AgentStore

    var body: some View {
        let payload = store.phonePairingPayload()
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { dismiss() }
            VStack(alignment: .leading, spacing: 12) {
                Text("Connect a phone").font(.ui(15, .semibold)).foregroundStyle(Theme.textPrimary)
                if let payload, let img = Self.qr(payload) {
                    Image(nsImage: img).interpolation(.none).resizable()
                        .frame(width: 220, height: 220)
                        .background(Color.white).cornerRadius(8)
                        .frame(maxWidth: .infinity, alignment: .center)
                    Text("Scan with the Shepherd app on your phone, then approve here.")
                        .font(.ui(12)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let label = store.phonePairingHostLabel() {
                        Text(label).font(.ui(11).monospaced()).foregroundStyle(Theme.textDim)
                            .textSelection(.enabled)
                    }
                } else {
                    Text("Tailscale is not running — can't build a pairing link.")
                        .font(.ui(13)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(18).frame(width: 300)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.ground)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1)))
            .shadow(color: .black.opacity(0.55), radius: 30, x: 0, y: 16)
        }
        .onExitCommand { dismiss() }
    }

    private static func qr(_ s: String) -> NSImage? {
        let ctx = CIContext()
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(s.utf8); f.correctionLevel = "M"
        guard let ci = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = ctx.createCGImage(ci, from: ci.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: ci.extent.width, height: ci.extent.height))
    }

    private func dismiss() { store.showingPhonePairingQR = false }
}
