import Foundation
import Security

/// Effectful FCM v1 sender. Holds a service-account key, mints + caches a short-lived
/// OAuth2 access token (RS256-signed JWT → token exchange), and POSTs DATA-ONLY messages.
/// Reaches Google (not the phone), so it wakes an app even when the phone is unreachable.
/// Pure message/claims construction lives in FCMMessage.swift; this is the shell.
final class FCMPusher {
    private let account: ServiceAccount
    private let privateKey: SecKey
    private let session = URLSession(configuration: .ephemeral)

    private let tokenLock = NSLock()
    private var accessToken: String?
    private var accessTokenExpiry = Date.distantPast

    /// nil if the key file is absent/unreadable/malformed — push then stays disabled, no error.
    init?(serviceAccountPath: String) {
        guard let data = FileManager.default.contents(atPath: serviceAccountPath),
              let account = try? parseServiceAccount(data),
              let key = FCMPusher.loadRSAPrivateKey(pem: account.privateKeyPEM) else { return nil }
        self.account = account
        self.privateKey = key
    }

    /// Send a data-only wake to each token. Returns the tokens Google rejected as
    /// UNREGISTERED / invalid-argument so the caller can drop them.
    func wake(tokens: [String], paneID: String, state: String, urgent: Bool) async -> [String] {
        guard !tokens.isEmpty, let token = await ensureAccessToken() else { return [] }
        var dead: [String] = []
        let url = URL(string: "https://fcm.googleapis.com/v1/projects/\(account.projectID)/messages:send")!
        for device in tokens {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: buildWakeMessage(
                token: device, paneID: paneID, state: state, urgent: urgent))
            guard let (body, resp) = try? await session.data(for: req),
                  let http = resp as? HTTPURLResponse else { continue }
            // 404 UNREGISTERED or 400 INVALID_ARGUMENT for the token ⇒ dead token, prune it.
            if http.statusCode == 404 ||
               (http.statusCode == 400 && (String(data: body, encoding: .utf8)?.contains("INVALID_ARGUMENT") ?? false)) {
                dead.append(device)
            }
        }
        return dead
    }

    // MARK: OAuth2 access token (cached ~1h)

    private func ensureAccessToken() async -> String? {
        tokenLock.lock()
        if let t = accessToken, Date() < accessTokenExpiry { tokenLock.unlock(); return t }
        tokenLock.unlock()
        guard let jwt = signedJWT() else { return nil }
        var req = URLRequest(url: URL(string: account.tokenURI)!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let form = "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=\(jwt)"
        req.httpBody = form.data(using: .utf8)
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = obj["access_token"] as? String else { return nil }
        let ttl = (obj["expires_in"] as? Int) ?? 3600
        tokenLock.lock()
        accessToken = access
        accessTokenExpiry = Date().addingTimeInterval(TimeInterval(ttl - 60))   // refresh a minute early
        tokenLock.unlock()
        return access
    }

    private func signedJWT() -> String? {
        let iat = Int(Date().timeIntervalSince1970)
        let signingInput = buildSigningInput(
            clientEmail: account.clientEmail, tokenURI: account.tokenURI,
            scope: "https://www.googleapis.com/auth/firebase.messaging", iat: iat)
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(privateKey, .rsaSignatureMessagePKCS1v15SHA256,
                                              Data(signingInput.utf8) as CFData, &error) as Data? else { return nil }
        return "\(signingInput).\(base64url(sig))"
    }

    // MARK: PEM (PKCS#8) → SecKey

    /// Google service-account keys are PKCS#8 (PEM-armored); SecKeyCreateWithData wants the
    /// inner PKCS#1 RSAPrivateKey. For RSA-2048 PKCS#8 the wrapper is a fixed 26-byte prefix
    /// (SEQUENCE | version INTEGER | rsaEncryption AlgId | OCTET STRING header), so we strip
    /// it. The manual auth check (Step 3) confirms the strip is correct.
    private static func loadRSAPrivateKey(pem: String) -> SecKey? {
        // Drop the PEM armor lines (any line wrapped in dashes) generically — no banner literal.
        let b64 = pem.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .filter { !$0.hasPrefix("-----") }
            .joined()
        guard let pkcs8 = Data(base64Encoded: b64), pkcs8.count > 26 else { return nil }
        let pkcs1 = pkcs8.subdata(in: 26..<pkcs8.count)
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrKeySizeInBits as String: 2048,
        ]
        var error: Unmanaged<CFError>?
        return SecKeyCreateWithData(pkcs1 as CFData, attrs as CFDictionary, &error)
    }
}
