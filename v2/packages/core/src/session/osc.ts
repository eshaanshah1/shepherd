/**
 * OSC 7 — `file://<host><percent-encoded-path>` — reduced to a path this machine
 * can actually open, or to nothing.
 *
 * Pure, and the hostname is a PARAMETER rather than an `os.hostname()` call:
 * core is process- and platform-agnostic, which is the same rule that keeps
 * `displayTitle` taking `home` instead of reading it.
 */

const FILE_SCHEME = 'file://';

/**
 * The path, when the payload names THIS machine. Otherwise nothing.
 *
 * The host check is not defensive tidiness. An `ssh` session running inside the
 * pane emits OSC 7 for the far machine, and a cwd is persisted — so accepting it
 * would make that pane restore into a directory that has never existed here.
 */
export function cwdFromOsc7(
  payload: string,
  localHostname: string | undefined,
): string | undefined {
  if (!payload.startsWith(FILE_SCHEME)) return undefined;
  const rest = payload.slice(FILE_SCHEME.length);
  const cut = rest.indexOf('/');
  if (cut < 0) return undefined;

  const host = rest.slice(0, cut);
  if (host !== '' && !sameMachine(host, localHostname)) return undefined;

  let path: string;
  try {
    path = decodeURIComponent(rest.slice(cut));
  } catch {
    // A malformed escape THROWS rather than returning a partial string, and a
    // prompt is not worth taking a pty's parser down over.
    return undefined;
  }
  return path.startsWith('/') ? path : undefined;
}

/**
 * First label, case-insensitively — because one machine is spelled three ways.
 * `zsh` sends `$HOST` (short), `os.hostname()` may answer an FQDN, and a whole
 * string comparison therefore rejects the machine the user is sitting at.
 */
function sameMachine(host: string, localHostname: string | undefined): boolean {
  if (localHostname === undefined || localHostname === '') return false;
  return label(host) === label(localHostname);
}

function label(name: string): string {
  const dot = name.indexOf('.');
  return (dot < 0 ? name : name.slice(0, dot)).toLowerCase();
}
