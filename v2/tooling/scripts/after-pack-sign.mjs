import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Give the packaged app a bundle identity, by ad-hoc signing it ourselves.
 *
 * `mac.identity: null` in electron-builder.yml does not mean "sign ad-hoc" — it
 * means **do not sign at all**, so the bundle keeps the signature the Electron
 * binary was linked with. That signature is real enough to launch and reads as
 * healthy at a glance, but its designated identifier is the literal string
 * `Electron`, its `Info.plist` is **not bound**, and it seals no resources:
 *
 *     $ codesign -dv --verbose=2 /Applications/Shep.app
 *     Identifier=Electron
 *     flags=0x20002(adhoc,linker-signed) hashes=9+0
 *     Info.plist=not bound
 *     Sealed Resources=none
 *
 * macOS identifies a notification client by its **code-signing identity**, not
 * by `CFBundleIdentifier`, so a bundle whose plist is unbound registers as
 * nothing: `Shep` never appears under System Settings → Notifications, there is
 * no switch to turn on, and every `new Notification(...).show()` is dropped with
 * `UNErrorDomain error 1` — not authorized. That is the failure `system-alerts
 * .ts` was written to make audible, and it was diagnosed there as a `pnpm dev`
 * artifact of running the unsigned `Electron.app` out of node_modules. It was
 * not: the **shipped** app had the same defect, for the same reason, and the
 * whole attention loop (banner, chime) has therefore never fired for anyone.
 *
 * v1 has always been signed — `codesign --force --deep --sign -` in its build —
 * which is why `Shepherd` and `Shepherd Dev` sit in that Settings list and
 * `Shep` does not. Ad-hoc is all that is needed: the identifier comes off the
 * bundle's own `CFBundleIdentifier`, so no Developer ID and no notarisation are
 * involved. This is a local-install concern, unchanged from the yml's note.
 *
 * **Inside-out, not `--deep`.** `--deep` is deprecated for signing and pushes
 * the outer `--identifier` onto nested code, which would stamp `com.shepherd
 * .shep` over each helper's own bundle id. Signing the frameworks and helper
 * apps first and the outer bundle last lets `codesign` derive every identifier
 * from the plist that owns it, and the result satisfies `codesign --verify
 * --deep --strict`.
 */

/** Ad-hoc sign one path, replacing whatever signature it arrived with. */
function sign(path) {
  execFileSync('codesign', ['--force', '--sign', '-', path], { stdio: 'pipe' });
}

export default async function afterPackSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworks = join(app, 'Contents/Frameworks');

  // Every nested `.framework` and helper `.app` is independently signed code
  // with its own plist; the outer bundle only seals them once they are stable.
  const nested = (await readdir(frameworks)).filter(
    (name) => name.endsWith('.framework') || name.endsWith('.app'),
  );
  for (const name of nested) sign(join(frameworks, name));
  sign(app);

  // Verify here rather than trusting the exit codes above: the defect this
  // whole file exists for was a signature that *succeeded* and still carried no
  // usable identity, so the check that matters is the one on the result.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  process.stdout.write(`  • ad-hoc signed ${nested.length + 1} bundles  identity=${context.packager.appInfo.id}\n`);
}
