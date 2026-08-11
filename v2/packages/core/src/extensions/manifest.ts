import {
  err,
  isPermission,
  manifestSchema,
  ok,
  PERMISSIONS,
  type ActivationEvent,
  type ContributedCommand,
  type ContributedView,
  type ExtensionSource,
  type Manifest,
  type Permission,
  type Result,
} from '@shepherd/sdk';

/**
 * Manifest validation, and the error a user can act on.
 *
 * `manifestSchema` is deliberately loose in the string fields — its own comment
 * says why: a structural parse that fails on `permissions` reports "expected one
 * of …" with **no extension id attached**, and an unreadable manifest has to
 * produce a sentence somebody can fix. So the semantic half lives here, where
 * every error names the extension, the field, and the offending value.
 *
 * Two rules it inherits from the `Schema` validator:
 *
 *   1. **Report all errors, not the first.** A manifest with four defects should
 *      take one fix cycle, not four.
 *   2. **Nothing throws.** A malformed manifest on disk must not be able to stop
 *      the app from starting, which is exactly what an exception on a load path
 *      does (v1's lesson, applied to a file the *user* wrote).
 */

export interface ManifestError {
  /**
   * The extension the error is about. `<unknown>` when the raw blob has no
   * usable id — which is itself one of the reported errors.
   */
  readonly id: string;
  /** Dotted, with array indices: `permissions[1]`, `contributes.commands[0].id`. */
  readonly field: string;
  readonly message: string;
  /**
   * Where the manifest came from. Nothing semantic depends on it — a built-in is
   * held to exactly the same validation, since a built-in that skipped these
   * checks would be the one manifest nobody ever proof-read. It rides the error
   * so a report can say whether the defect is the user's or ours to fix.
   */
  readonly source: ExtensionSource;
}

const UNKNOWN_ID = '<unknown>';
const ROOT_FIELD = '<root>';

/** `shepherd.tasks` — reverse-dotted, at least one dot, no empty segments. */
const ID_SHAPE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
/** `1.2.3`, `0.0.0-dev`, `1.0.0+sha.abc`. A prerelease is allowed on purpose. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExtensionIdShape(value: string): boolean {
  return ID_SHAPE.test(value);
}

export function isVersion(value: string): boolean {
  return VERSION_SHAPE.test(value);
}

/**
 * A range this build can read: an exact version, optionally prefixed with one
 * `^` or `~`. Shape only — **nothing here decides whether a range is satisfied**,
 * because nothing in this phase compares an extension's range against the host
 * version. That is why `*`, `>=1.0.0` and `1.x` are rejected rather than passed
 * through: accepting an operator we do not parse means the comparison that lands
 * later reads it wrong, silently.
 */
export function isVersionRange(value: string): boolean {
  const bare = value.startsWith('^') || value.startsWith('~') ? value.slice(1) : value;
  return isVersion(bare);
}

export function parseManifest(raw: unknown, source: ExtensionSource): Result<Manifest, ManifestError[]> {
  const id = looseId(raw);
  const structural = manifestSchema.parse(raw);
  if (!structural.ok) {
    return err(
      structural.error.map((issue) => ({
        id,
        field: issue.path === '' ? ROOT_FIELD : issue.path,
        message: issue.message,
        source,
      })),
    );
  }

  // The semantic checks read fields the schema has already proven present. Running
  // them over a shape that failed would add a second, misleading complaint about a
  // field the reader cannot see — hence the early return above, which is the one
  // place this function does not accumulate.
  const parsed = structural.value;
  const errors: ManifestError[] = [];
  const report = (field: string, message: string): void => void errors.push({ id: parsed.id, field, message, source });

  const idProblem = describeIdProblem(parsed.id);
  if (idProblem !== undefined) report('id', idProblem);

  if (!isVersion(parsed.version)) {
    report('version', `version must be major.minor.patch, got ${quote(parsed.version)}`);
  }
  if (!isVersionRange(parsed.api)) {
    report(
      'api',
      `api must be a version or a ^/~ range (e.g. "^1.0.0"), got ${quote(parsed.api)}`,
    );
  }

  // Field order follows the `Manifest` interface, so a report reads top-to-bottom
  // against the file the user is looking at.
  parsed.activation.forEach((event, index) => {
    const problem = describeActivationProblem(event);
    if (problem !== undefined) report(`activation[${index}]`, problem);
  });

  parsed.permissions.forEach((permission, index) => {
    if (isPermission(permission)) return;
    // Naming the valid set here is the difference between an error a user fixes
    // and one they file. The set is small on purpose (permission.ts), so printing
    // it costs a line.
    report(
      `permissions[${index}]`,
      `unknown permission ${quote(permission)}. Valid permissions: ${PERMISSIONS.join(', ')}`,
    );
  });

  const commands = parsed.contributes?.commands ?? [];
  const seen = new Set<string>();
  commands.forEach((command, index) => {
    const field = `contributes.commands[${index}].id`;
    if (command.id.trim() === '') {
      report(field, 'a contributed command needs a non-empty id');
      return;
    }
    // Reported at the SECOND occurrence: the registry throws on a duplicate at
    // register time, and catching it here means the copy is a manifest defect
    // rather than a mid-activation crash that leaves half the extension wired up.
    if (seen.has(command.id)) report(field, `duplicate contributed command id ${quote(command.id)}`);
    seen.add(command.id);
  });

  (parsed.dependencies ?? []).forEach((dependency, index) => {
    const field = `dependencies[${index}]`;
    if (dependency === parsed.id) {
      // Resolving your own id through `extensions.get` is either a no-op or a
      // re-entrant activation. Neither has a useful reading, so it is a defect.
      report(field, `an extension may not declare a dependency on itself (${quote(dependency)})`);
      return;
    }
    if (!isExtensionIdShape(dependency)) {
      report(field, `dependency ${quote(dependency)} is not a reverse-dotted extension id`);
    }
  });

  if (errors.length > 0) return err(errors);

  // The one cast in this file, and it is after every check: the schema types these
  // as `string[]` deliberately (see its comment) and this is where they become the
  // closed unions `Manifest` declares.
  const manifest: Manifest = {
    id: parsed.id,
    name: parsed.name,
    version: parsed.version,
    api: parsed.api,
    activation: parsed.activation as ActivationEvent[],
    permissions: parsed.permissions as Permission[],
    // Absent stays absent. `'dependencies' in manifest` is how a caller reads
    // this, and an undefined-valued key answers that question wrong.
    ...(parsed.dependencies === undefined ? {} : { dependencies: parsed.dependencies }),
    ...(parsed.contributes === undefined ? {} : { contributes: contributionsOf(parsed.contributes) }),
  };
  return ok(manifest);
}

function contributionsOf(raw: {
  commands?: { id: string; title?: string; key?: string }[];
  views?: { id: string; type: string; title: string; region?: string }[];
}): { commands?: readonly ContributedCommand[]; views?: readonly ContributedView[] } {
  return {
    ...(raw.commands === undefined ? {} : { commands: raw.commands }),
    ...(raw.views === undefined ? {} : { views: raw.views }),
  };
}

function describeIdProblem(id: string): string | undefined {
  // Whitespace gets its own sentence: a trailing space is invisible in an editor,
  // and "must be reverse-dotted" reads as nonsense next to an id that looks right.
  if (/\s/.test(id)) return `id must not contain whitespace, got ${quote(id)}`;
  if (!ID_SHAPE.test(id)) {
    return `id must be reverse-dotted, e.g. "shepherd.tasks", got ${quote(id)}`;
  }
  return undefined;
}

/**
 * An activation event that can never match is an extension that will never load
 * — the silent-no-op class this kernel exists to refuse. `onCommand:` with an
 * empty suffix is exactly that, and it looks correct at a glance.
 */
function describeActivationProblem(event: string): string | undefined {
  if (event === 'onStartup') return undefined;
  for (const prefix of ['onCommand:', 'onView:'] as const) {
    if (!event.startsWith(prefix)) continue;
    return event.slice(prefix.length).trim() === ''
      ? `${prefix} needs a non-empty id, got ${quote(event)}`
      : undefined;
  }
  return (
    `unknown activation event ${quote(event)}. ` +
    'Valid events: onStartup, onCommand:<command-id>, onView:<view-type>'
  );
}

/**
 * The id to attribute a *structural* failure to, best-effort: the schema has not
 * run yet, so this is the only thing standing between "your manifest is broken"
 * and a message that says which manifest.
 */
function looseId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return UNKNOWN_ID;
  const candidate = (raw as { id?: unknown }).id;
  return typeof candidate === 'string' && candidate !== '' ? candidate : UNKNOWN_ID;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
