/**
 * OSC 7 — `file://<host><percent-encoded-path>` — reduced to a path this machine
 * can actually open, or to nothing.
 *
 * Pure, and the hostname is a PARAMETER rather than an `os.hostname()` call:
 * core is process- and platform-agnostic, and nothing here may reach the machine
 * it happens to be running on.
 */

const FILE_SCHEME = 'file://';

/**
 * `user@host`, or `user@host:/some/path` — what a shell sets its title to when it
 * is sitting at a prompt with nothing running (zsh's `%n@%m:%~`, bash's
 * `\u@\h:\w`).
 *
 * Neither half is a name for a tab: the machine is the one you are on and the
 * directory is already `Pane.cwd`. One `@`, no whitespace before the colon —
 * narrow on purpose, so a program that genuinely titles itself `deploy@staging`
 * keeps its name while `git commit` and `ssh box` (both of which contain a
 * space) never match in the first place.
 */
const SHELL_PROMPT_TITLE = /^[^\s@]+@[^\s@:]+(?::.*)?$/;

/** Whether an OSC title is a shell's idle prompt rather than a program's name. */
export function isShellPromptTitle(title: string): boolean {
  return SHELL_PROMPT_TITLE.test(title);
}

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
