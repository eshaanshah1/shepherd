import { safeStorage } from 'electron';
import type { Cipher } from '@shepherd/core';

/**
 * The OS keychain, as the one thing core knows about encryption.
 *
 * `safeStorage` is Electron's wrapper over the platform credential store — the
 * macOS Keychain here — and it is the right primitive for exactly one reason:
 * **it means this app never holds a key.** A secrets store that encrypted with a
 * key it also stored would be obfuscation with extra steps, and the honest
 * alternative (a passphrase the user types at launch) is a worse product than
 * the keychain the user already trusts with everything else.
 *
 * It lives in main because `electron` does, and it is handed to core as a
 * `Cipher` because core is the part of this app with no machine under it.
 *
 * ── availability is checked per call, not once ───────────────────────────────
 *
 * `isEncryptionAvailable()` becomes true during startup on macOS (it needs the
 * app to be far enough along to talk to the keychain), so a cipher that decided
 * at construction would refuse for the life of a process that merely built this
 * early. It is also genuinely false on some Linux desktops, which is the case
 * `SecretsRegistry` refuses to write into rather than storing plaintext.
 */
export function keychainCipher(): Cipher {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        // Throwing rather than answering is not documented and has been seen on
        // headless CI. Treated as "no", which is the safe reading: the store
        // then refuses to write, and nothing lands in the clear.
        return false;
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    /*
     * `Buffer.from(bytes)` rather than passing the view straight through:
     * `decryptString` wants a Buffer, and a `Uint8Array` off a
     * `SharedArrayBuffer` is not one — the same conversion `sessions.capture`
     * makes, for the same reason.
     */
    decrypt: (bytes) => safeStorage.decryptString(Buffer.from(bytes)),
  };
}
