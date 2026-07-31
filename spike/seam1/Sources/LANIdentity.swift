import Foundation
import Security
import CryptoKit

/// The host's LAN TLS identity: a self-signed RSA-2048 cert minted once by /usr/bin/openssl
/// and imported through `SecPKCS12Import`.
///
/// RSA rather than EC because an EC p12 written by the system LibreSSL makes
/// `SecPKCS12Import` raise an ObjC exception from inside `SecIdentityCreate` — a crash, not
/// an error code. The passphrase is a constant and is not the protection: the 0600 file mode
/// is, exactly as for an unencrypted `~/.ssh/id_ed25519`. An empty passphrase is rejected
/// outright (`-25293`), so there has to be one.
enum LANIdentity {
    static let passphrase = "shepherd"

    static func p12Path(_ dir: String) -> String {
        (dir as NSString).appendingPathComponent("lan-identity.p12")
    }

    /// The identity to serve with, minting it on first use. Reused forever after — every
    /// client pins this certificate, so re-minting silently breaks all of them.
    static func loadOrMint(dir: String) -> (identity: SecIdentity, certHash: Data)? {
        let path = p12Path(dir)
        if !FileManager.default.fileExists(atPath: path), !mint(dir: dir) { return nil }
        guard let identity = load(path) else { return nil }
        return (identity, certHash(of: identity))
    }

    /// Forget the identity. Callers must also drop every LAN pairing: the pins are now wrong.
    static func reset(dir: String) {
        try? FileManager.default.removeItem(atPath: p12Path(dir))
    }

    /// SHA-256 of the whole certificate DER — the one representation Swift and Kotlin can
    /// produce identically (`SecCertificateCopyData` / `cert.encoded`).
    static func certHash(of identity: SecIdentity) -> Data {
        var cert: SecCertificate?
        SecIdentityCopyCertificate(identity, &cert)
        guard let cert else { return Data() }
        return Data(SHA256.hash(data: SecCertificateCopyData(cert) as Data))
    }

    private static func load(_ path: String) -> SecIdentity? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        var items: CFArray?
        guard SecPKCS12Import(data as CFData,
                              [kSecImportExportPassphrase as String: passphrase] as CFDictionary,
                              &items) == errSecSuccess,
              let arr = items as? [[String: Any]],
              let ident = arr.first?[kSecImportItemIdentity as String] else { return nil }
        return (ident as! SecIdentity)
    }

    private static func mint(dir: String) -> Bool {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let key = (dir as NSString).appendingPathComponent("lan-key.pem")
        let cert = (dir as NSString).appendingPathComponent("lan-cert.pem")
        defer { for f in [key, cert] { try? FileManager.default.removeItem(atPath: f) } }
        guard run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7300",
                   "-subj", "/CN=Shepherd LAN", "-keyout", key, "-out", cert]),
              run(["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12Path(dir),
                   "-passout", "pass:\(passphrase)", "-name", "Shepherd LAN"])
        else { return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                              ofItemAtPath: p12Path(dir))
        return true
    }

    private static func run(_ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}

/// Six digits both ends derive from the server certificate's SHA-256. A man in the middle
/// must present its own certificate, so its digits differ — that is the whole detection, and
/// it needs no TLS exporter. Byte-pinned in Swift and Kotlin tests against the same vector;
/// changing the derivation invalidates every paired device's comparison.
func sasDigits(certHash: Data) -> String {
    let n = certHash.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    return String(format: "%06u", n % 1_000_000)
}

/// The real SAS among decoys at a caller-chosen index — randomness stays out of the model,
/// the way `pairingDecision` takes `newSecret` rather than minting one.
func sasChoices(real: String, decoys: [String], insertAt: Int) -> [String] {
    var out = decoys
    out.insert(real, at: min(max(0, insertAt), out.count))
    return out
}

/// The host-shown pairing code: 6 digits, 5 minutes, 3 attempts, one device. Authorization
/// only — it proves a human is standing at the host. Authenticating the channel is the SAS's
/// job, and conflating the two is how short-code pairing gets broken.
struct LANCode: Equatable {
    static let lifetime: TimeInterval = 300
    let digits: String
    let issued: Date
    var attemptsLeft: Int

    static func fresh(now: Date, digits: String) -> LANCode {
        LANCode(digits: digits, issued: now, attemptsLeft: 3)
    }

    func isValid(now: Date) -> Bool {
        attemptsLeft > 0 && now.timeIntervalSince(issued) <= Self.lifetime
    }
}
