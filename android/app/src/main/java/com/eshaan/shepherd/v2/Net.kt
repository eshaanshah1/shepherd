package com.eshaan.shepherd.v2

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.util.PrivateKeyInfoFactory
import org.bouncycastle.crypto.util.PublicKeyFactory
import org.bouncycastle.crypto.util.PrivateKeyFactory
import org.bouncycastle.crypto.util.SubjectPublicKeyInfoFactory
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Membership in a shep-net, as this phone speaks it.
 *
 * The model this replaces was pairwise: the Mac issued this phone a `secret` and
 * the phone pinned that one Mac's certificate, so every Mac cost its own
 * ceremony. Here the phone joins a NET once and every Mac in it admits the phone
 * on sight — including Macs it has never connected to.
 *
 * What the phone holds is a key pair and a **chain**: its own credential, signed
 * by whichever member admitted it, up to one signed by the net's root key. The
 * net's id is the SHA-256 of that root public key, so the id and the key check
 * each other and neither can be swapped alone.
 *
 * **The canonical form is the interop surface, and it is not JSON-as-you-like.**
 * A signature covers a JSON *array* rendered exactly as the Mac's
 * `JSON.stringify` renders it — fixed order, no spaces, and JavaScript's own
 * escaping rules. `NetTest` pins every one of those strings against bytes the Mac
 * produced, because "both sides used JSON" is not a guarantee that both sides
 * produced the same bytes.
 */
data class Credential(
    val netId: String,
    val epoch: Int,
    val memberId: String,
    val name: String,
    /** The member's signing key, hex SPKI DER. */
    val publicKey: String,
    /** Hex SHA-256 of the member's TLS certificate DER; empty when it serves nothing. */
    val certPin: String,
    val issuedAt: Long,
    /** The `memberId` that admitted this one, or [Net.ROOT]. */
    val issuer: String,
    val signature: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("netId", netId)
        .put("epoch", epoch)
        .put("memberId", memberId)
        .put("name", name)
        .put("publicKey", publicKey)
        .put("certPin", certPin)
        .put("issuedAt", issuedAt)
        .put("issuer", issuer)
        .put("signature", signature)

    companion object {
        fun fromJson(json: JSONObject) = Credential(
            netId = json.getString("netId"),
            epoch = json.optInt("epoch", 1),
            memberId = json.getString("memberId"),
            name = json.optString("name", ""),
            publicKey = json.getString("publicKey"),
            certPin = json.optString("certPin", ""),
            issuedAt = json.optLong("issuedAt", 0L),
            issuer = json.getString("issuer"),
            signature = json.getString("signature"),
        )

        fun listFromJson(array: JSONArray): List<Credential> =
            (0 until array.length()).map { fromJson(array.getJSONObject(it)) }

        fun listToJson(chain: List<Credential>): JSONArray =
            JSONArray().apply { chain.forEach { put(it.toJson()) } }
    }
}

object Net {
    /** The issuer of a founding member's credential: the net's root key itself. */
    const val ROOT = "root"

    /** As on the Mac: a bound on work a stranger can ask for before being admitted. */
    const val MAX_CHAIN = 8

    fun credentialBytes(credential: Credential): ByteArray = canonical(
        "shepherd-net-credential-v1",
        credential.netId,
        credential.epoch,
        credential.memberId,
        credential.name,
        credential.publicKey,
        credential.certPin,
        credential.issuedAt,
        credential.issuer,
    )

    /**
     * What this phone signs to prove it holds the key its chain names.
     *
     * Bound to the HOST's certificate pin, so a proof captured by one Mac is
     * worthless at another, and stamped with a time, so it expires. The phone
     * speaks first and therefore has no nonce to answer — that is the host's
     * direction, below.
     */
    fun proofBytes(netId: String, hostPin: String, at: Long): ByteArray =
        canonical("shepherd-net-proof-v1", netId, hostPin, at)

    /** What the HOST signs to prove itself: the nonce this phone chose. */
    fun hostProofBytes(netId: String, nonce: String): ByteArray =
        canonical("shepherd-net-host-proof-v1", netId, nonce)

    /** Admit somebody — used in tests today; the phone admits nobody yet. */
    @Suppress("LongParameterList")
    fun issue(
        netId: String,
        epoch: Int,
        memberId: String,
        name: String,
        publicKey: String,
        certPin: String,
        issuedAt: Long,
        issuer: String,
        privateKey: String,
    ): Credential {
        val unsigned = Credential(netId, epoch, memberId, name, publicKey, certPin, issuedAt, issuer, "")
        return unsigned.copy(signature = NetCrypto.sign(privateKey, credentialBytes(unsigned)))
    }

    /**
     * Is this chain a membership of this net? Returns the refusal, or null when
     * it is good — so a caller cannot mistake "no reason" for "no answer".
     *
     * The order matters and mirrors the host's: identity claims first, so a
     * malformed chain costs no signature checks, and revocation is checked across
     * the WHOLE chain rather than the leaf alone. A member admitted by a device
     * that has since been revoked falls with it, or revoking a lost phone would
     * leave everything it ever admitted inside the net.
     */
    fun verifyChain(
        chain: List<Credential>,
        netId: String,
        rootPublicKey: String,
        revoked: Set<String>,
    ): String? {
        if (chain.isEmpty()) return "that device presented no membership at all"
        if (chain.size > MAX_CHAIN) return "a membership chain may not be ${chain.size} links long"

        for (link in chain) {
            if (link.netId != netId) return "that membership is for a different net"
            if (revoked.contains(link.memberId)) {
                return if (link.memberId == chain.first().memberId) {
                    "that device was revoked"
                } else {
                    "it was admitted by ${link.name}, which was revoked"
                }
            }
        }

        for (i in 0 until chain.size - 1) {
            if (chain[i].issuer != chain[i + 1].memberId) return "that membership chain does not join up"
        }
        if (chain.last().issuer != ROOT) return "that membership does not chain to the root of this net"

        for (i in chain.indices) {
            val key = if (i == chain.size - 1) rootPublicKey else chain[i + 1].publicKey
            if (!NetCrypto.verify(key, credentialBytes(chain[i]), chain[i].signature)) {
                return "the signature on ${chain[i].name}'s membership does not check out"
            }
        }
        return null
    }

    /**
     * The Mac's `JSON.stringify` of an array, reproduced exactly.
     *
     * Hand-rolled rather than handed to a JSON library, because what is needed
     * here is not "valid JSON" but *these bytes*: `org.json` inserts nothing and
     * escapes slightly differently, and a signature over a nearly-identical
     * string is a signature that fails on the other machine with nothing to
     * explain it.
     */
    private fun canonical(vararg values: Any): ByteArray {
        val out = StringBuilder("[")
        values.forEachIndexed { index, value ->
            if (index > 0) out.append(',')
            when (value) {
                is String -> escape(value, out)
                else -> out.append(value.toString())
            }
        }
        return out.append(']').toString().toByteArray(Charsets.UTF_8)
    }

    /** JavaScript's string escaping: quote, backslash, and the C0 controls. */
    private fun escape(value: String, out: StringBuilder) {
        out.append('"')
        for (ch in value) {
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch == '\b' -> out.append("\\b")
                ch == '' -> out.append("\\f")
                ch == '\n' -> out.append("\\n")
                ch == '\r' -> out.append("\\r")
                ch == '\t' -> out.append("\\t")
                ch < ' ' -> out.append("\\u%04x".format(ch.code))
                else -> out.append(ch)
            }
        }
        out.append('"')
    }
}

/** This device's signing key for a net. Hex DER both ways, as the wire carries it. */
data class MemberKey(val publicKey: String, val privateKey: String)

/**
 * The one place this app touches a signature primitive.
 *
 * Bouncy Castle's lightweight API rather than JCA: `Ed25519` only reaches the
 * platform provider at API 33, and `minSdk` is 31 — a signing scheme that works
 * on some phones is a net that admits some phones. It also means these paths run
 * in plain JVM unit tests, which is how they are held to the Mac's bytes.
 *
 * Keys travel as **hex DER** (SPKI public, PKCS8 private) because that is what
 * the Mac reads back, and because they ride inside JSON frames where PEM's
 * armour and newlines survive badly.
 */
object NetCrypto {
    private val random = SecureRandom()

    fun generateMemberKey(): MemberKey {
        val generator = Ed25519KeyPairGenerator()
        generator.init(Ed25519KeyGenerationParameters(random))
        val pair = generator.generateKeyPair()
        return MemberKey(
            publicKey = SubjectPublicKeyInfoFactory
                .createSubjectPublicKeyInfo(pair.public as Ed25519PublicKeyParameters).encoded.toHex(),
            privateKey = PrivateKeyInfoFactory
                .createPrivateKeyInfo(pair.private as Ed25519PrivateKeyParameters).encoded.toHex(),
        )
    }

    fun sign(privateKeyHex: String, message: ByteArray): String {
        val key = PrivateKeyFactory.createKey(privateKeyHex.fromHex()) as Ed25519PrivateKeyParameters
        val signer = Ed25519Signer()
        signer.init(true, key)
        signer.update(message, 0, message.size)
        return signer.generateSignature().toHex()
    }

    /**
     * Total, because it is fed whatever a peer sent.
     *
     * A malformed key or a signature that is not hex has to be a refusal, not a
     * crash on the connection path — the same rule the host keeps, for the same
     * reason.
     */
    fun verify(publicKeyHex: String, message: ByteArray, signatureHex: String): Boolean = runCatching {
        val key = PublicKeyFactory.createKey(publicKeyHex.fromHex()) as Ed25519PublicKeyParameters
        val signer = Ed25519Signer()
        signer.init(false, key)
        signer.update(message, 0, message.size)
        signer.verifySignature(signatureHex.fromHex())
    }.getOrDefault(false)

    /** A net's id: the SHA-256 of its root public key, lowercase hex. */
    fun netIdOf(rootPublicKeyHex: String): String =
        MessageDigest.getInstance("SHA-256").digest(rootPublicKeyHex.fromHex()).toHex()

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private fun String.fromHex(): ByteArray {
        require(length % 2 == 0) { "hex of odd length" }
        return ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
