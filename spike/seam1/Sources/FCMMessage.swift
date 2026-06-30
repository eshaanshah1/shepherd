import Foundation

/// Pure FCM message + JWT-claims + dedup model. No AppKit / no crypto / no network —
/// the effectful pusher (FCMPusher.swift) signs + sends. Kept pure so it is unit-tested
/// like StopPolicy/SleepPolicy; `iat`/`now` are passed in to keep Date.now out of the model.

struct ServiceAccount: Equatable {
    let clientEmail: String
    let privateKeyPEM: String
    let projectID: String
    let tokenURI: String
}

enum FCMMessageError: Error { case malformedKey }

/// Parse a Google service-account JSON key into the fields the pusher needs.
func parseServiceAccount(_ json: Data) throws -> ServiceAccount {
    guard let obj = try JSONSerialization.jsonObject(with: json) as? [String: Any],
          let email = obj["client_email"] as? String,
          let key = obj["private_key"] as? String,
          let project = obj["project_id"] as? String else { throw FCMMessageError.malformedKey }
    let tokenURI = (obj["token_uri"] as? String) ?? "https://oauth2.googleapis.com/token"
    return ServiceAccount(clientEmail: email, privateKeyPEM: key, projectID: project, tokenURI: tokenURI)
}

/// base64url (RFC 7515): standard base64, +→-, /→_, no padding.
func base64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// The `header.claims` JWT signing input for an FCM service-account access-token request.
/// The caller RS256-signs this string's UTF-8 bytes and appends `.signature`.
func buildSigningInput(clientEmail: String, tokenURI: String, scope: String, iat: Int) -> String {
    let header = #"{"alg":"RS256","typ":"JWT"}"#
    // JSONSerialization key order isn't guaranteed; build claims JSON deterministically so
    // tests (and signatures) are stable. Google validates fields, not byte order, so this is safe.
    let claims = "{\"iss\":\"\(clientEmail)\",\"scope\":\"\(scope)\",\"aud\":\"\(tokenURI)\",\"iat\":\(iat),\"exp\":\(iat + 3600)}"
    let h = base64url(Data(header.utf8))
    let c = base64url(Data(claims.utf8))
    return "\(h).\(c)"
}

/// The FCM HTTP v1 `messages:send` body — DATA-ONLY (no `notification` block, so no
/// terminal content transits Google; the woken app raises its own local notification).
func buildWakeMessage(token: String, paneID: String, state: String, urgent: Bool) -> [String: Any] {
    [
        "message": [
            "token": token,
            "data": ["paneID": paneID, "state": state, "urgent": urgent ? "true" : "false"],
            "android": ["priority": urgent ? "high" : "normal"],
        ] as [String: Any]
    ]
}

/// Coalesce: don't re-push the same state for the same pane within `window` seconds — guards
/// a flapping pane from a buzz-storm. A different state, a new pane, or a lapsed window pushes.
enum PushDecision {
    static func shouldPush(paneID: String, state: String,
                           lastPushed: [String: (state: String, at: Date)],
                           now: Date, window: TimeInterval) -> Bool {
        guard let last = lastPushed[paneID] else { return true }
        if last.state != state { return true }
        return now.timeIntervalSince(last.at) >= window
    }
}
