import { s, type Schema } from './schema.ts';
import type { Permission } from './permission.ts';

/**
 * The `shepherd` key of an extension's package.json (core-design §4).
 *
 * Activation is lazy by declaration: an extension that only answers a command
 * should not run at startup. `onStartup` exists but earns its keep rarely —
 * `agents-core` needs it because it must see sessions it did not create.
 */
export type ActivationEvent =
  | 'onStartup'
  /** `onCommand:tasks.create` */
  | `onCommand:${string}`
  /** `onView:tasks.sidebar` — lands with the first real view contribution (M3). */
  | `onView:${string}`;

export interface ContributedCommand {
  readonly id: string;
  /**
   * What a person reads in the palette. **Absent = not user-facing**, which is
   * the same meaning `title` has where a command is registered.
   *
   * Optional because some verbs exist to be ASKED rather than chosen: a row's
   * `presents` verb answers what it stands for and performs nothing, so an entry
   * for it in the palette would run a command whose entire effect is a return
   * value. Declaring it is still worth doing — the manifest is where an
   * extension's surface is enumerated — so the choice is between a title that
   * lies and a title that is absent.
   */
  readonly title?: string;
  /** Accelerator in Electron's vocabulary, e.g. `CmdOrCtrl+Shift+D`. */
  readonly key?: string;
}

export interface ContributedView {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  /** Where it wants to live. The user may move it — this is only a default. */
  readonly region?: string;
}

export interface Manifest {
  /** Reverse-dotted, e.g. `shepherd.tasks`. Unique per installation. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** The host API range this extension was tested against. */
  readonly api: string;
  readonly activation: readonly ActivationEvent[];
  readonly permissions: readonly Permission[];
  /**
   * Other extensions whose exported APIs this one calls, by id.
   *
   * The sketch's §3 table is a set of dependency arrows (`claude-code →
   * agents-core`, `tasks → worktrees`, `remote-lan → remote-core`) and this is
   * where they become real: `extensions.get(id)` resolves **only** ids declared
   * here, so reaching another extension's API is a reviewable fact in the
   * manifest rather than a string a caller invents at runtime. It also gives the
   * host somewhere to check that the dependency is present and active before
   * activating the dependent, instead of failing later with an undefined.
   */
  readonly dependencies?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly ContributedCommand[];
    readonly views?: readonly ContributedView[];
  };
}

/**
 * The manifest as it appears on disk, before validation.
 *
 * Deliberately loose in the string fields (`activation`, `permissions`) so that
 * an unknown permission or a mistyped activation event is reported by the
 * *loader*, naming the extension and the bad value, rather than failing a
 * structural parse with "expected one of …" and no id attached. An unreadable
 * manifest must produce a sentence a user can act on.
 */
export const manifestSchema: Schema<{
  id: string;
  name: string;
  version: string;
  api: string;
  activation: string[];
  permissions: string[];
  dependencies?: string[];
  contributes?: {
    /** `title` optional — absent means not user-facing. See `ContributedCommand`. */
    commands?: { id: string; title?: string; key?: string }[];
    views?: { id: string; type: string; title: string; region?: string }[];
  };
}> = s.object({
  id: s.string(),
  name: s.string(),
  version: s.string(),
  api: s.string(),
  activation: s.array(s.string()),
  permissions: s.array(s.string()),
  dependencies: s.optional(s.array(s.string())),
  contributes: s.optional(
    s.object({
      commands: s.optional(
        s.array(
          s.object({
            id: s.string(),
            title: s.optional(s.string()),
            key: s.optional(s.string()),
          }),
        ),
      ),
      views: s.optional(
        s.array(
          s.object({
            id: s.string(),
            type: s.string(),
            title: s.string(),
            region: s.optional(s.string()),
          }),
        ),
      ),
    }),
  ),
});
