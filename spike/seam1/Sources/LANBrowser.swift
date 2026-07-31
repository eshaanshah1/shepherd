import Foundation
import Network

/// One Shepherd host seen advertising itself on the local link. It is a *claim*, not an
/// identity: anything on the network can publish this service, so a browse result only ever
/// means "somewhere to try pairing", never "your Mac".
struct LANHost: Equatable, Identifiable {
    let id: String            // the Bonjour instance name — unique per host on this link
    let name: String          // display name, self-reported
    let endpoint: NWEndpoint
}

/// Bonjour discovery of `_shepherd._tcp` on the local link. Runs only while the pairing sheet
/// is open — a browser left running is a wakeup source, and there is nothing to do with results
/// nobody is looking at.
final class LANBrowser {
    private var browser: NWBrowser?
    var onChange: (([LANHost]) -> Void)?

    func start() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = false
        let b = NWBrowser(for: .bonjour(type: "_shepherd._tcp", domain: nil), using: params)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let hosts = results.compactMap { r -> LANHost? in
                guard case let .service(name, _, _, _) = r.endpoint else { return nil }
                return LANHost(id: name, name: name, endpoint: r.endpoint)
            }.sorted { $0.name < $1.name }
            DispatchQueue.main.async { self?.onChange?(hosts) }
        }
        b.start(queue: .global(qos: .userInitiated))
        browser = b
    }

    func stop() {
        browser?.cancel(); browser = nil
        onChange?([])
    }
}
