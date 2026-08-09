import { extensionId, type Caller, type TreeItem } from '@shepherd/sdk';

/**
 * What main knows about contributed views — M3's answer to the relay allow-list.
 *
 * Until now, exactly one bus topic reached the renderer and main knew its name
 * (`agent-relay.ts`: "an allow-list, not a subscription API… this table is what
 * M3's declarative view contributions replace"). This is the replacement: an
 * extension declares a view, main learns of it generically, and the renderer
 * draws whatever is declared. Main no longer knows any extension's topic.
 *
 * It holds **no provider**. A `TreeDataProvider` is functions, which cannot
 * cross a port, so this holds the *ownership* — which extension contributed
 * which view type — and reads rows by asking that extension. Ownership is the
 * interesting half anyway, because it is what makes D14 answerable.
 */

export interface ViewRegistryOptions {
  /** Ask an extension for a tree's rows. */
  read(extension: string, type: string, parent: string | undefined): Promise<readonly TreeItem[]>;
  /** The command registry, so a row click can do something. */
  invoke(command: string, args: unknown, caller: Caller): Promise<unknown>;
  /** Tell the renderer a view changed. */
  publish(type: string): void;
}

/** What a contributed view is drawn as. `panel` still refuses (ADR 0031). */
export type ViewKind = 'tree' | 'component';

export interface Contribution {
  readonly extension: string;
  readonly type: string;
  readonly kind: ViewKind;
  /**
   * The UI module the renderer resolves, for a `component` view (ADR 0033).
   *
   * A name, never code: this registry runs in main and has no DOM, and the
   * child that declared it has no react. The renderer is the only process that
   * can turn this into pixels, and it does so from its own static table — so an
   * extension names a module, it does not supply one.
   */
  readonly component?: string;
  /** Dock section or modal overlay. Components only; a tree is always a dock. */
  readonly surface?: 'dock' | 'overlay';
  /** The accelerator that raises an overlay. A modifier is required. */
  readonly key?: string;
  /** The heading the shell draws. Falls back to the view type. */
  readonly title?: string;
  /** The glyph on the control that raises an overlay. Defaults to `plus`. */
  readonly icon?: string;
}

/** Everything a contribution declares beyond its kind. */
export interface ViewDeclaration {
  readonly surface?: 'dock' | 'overlay';
  readonly key?: string;
  readonly title?: string;
  readonly icon?: string;
}

const MODIFIERS = new Set(['command','cmd','control','ctrl','commandorcontrol','cmdorctrl','alt','option','altgr','shift','super','meta']);

/**
 * True when an accelerator can only fire with a modifier held.
 *
 * The same predicate `menu-template.ts` applies to the app's own menu, for the
 * same reason and now on behalf of extensions: a bare letter bound globally is
 * that letter untypeable in every terminal.
 */
export function hasModifier(accelerator: string): boolean {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase());
  return parts.length > 1 && parts.slice(0, -1).every((part) => MODIFIERS.has(part));
}

export class ViewRegistry {
  readonly #options: ViewRegistryOptions;
  /** view type → what was contributed, including which extension owns it. */
  readonly #owners = new Map<string, Contribution>();

  constructor(options: ViewRegistryOptions) {
    this.#options = options;
  }

  /**
   * Record a contribution — and TELL the renderer.
   *
   * The notify is not optional. Extensions activate after the window has loaded,
   * so the renderer's first `list()` is answered before any of them has
   * registered; without a nudge here, a view that arrives later is one the page
   * never learns about and the dock stays empty forever. Measured: the tree
   * registered, main logged it, and the screen showed nothing.
   */
  register(
    extension: string,
    type: string,
    kind: ViewKind = 'tree',
    component?: string,
    declaration: ViewDeclaration = {},
  ): void {
    this.#owners.set(type, {
      extension,
      type,
      kind,
      ...(component === undefined ? {} : { component }),
      // An accelerator with no modifier is dropped rather than honoured: a bare
      // key bound here is a key deleted from every terminal in the app, which is
      // v1's menu-accelerator lesson and not something an extension gets to do.
      ...(declaration.surface === undefined ? {} : { surface: declaration.surface }),
      ...(declaration.key === undefined || !hasModifier(declaration.key) ? {} : { key: declaration.key }),
      ...(declaration.title === undefined ? {} : { title: declaration.title }),
      // An unknown name is passed through and the renderer falls back to `plus`
      // — the same rule a row's action glyph gets: a typo must not be louder
      // than the label beside it.
      ...(declaration.icon === undefined ? {} : { icon: declaration.icon }),
    });
    this.#options.publish(type);
  }

  unregister(type: string): void {
    this.#owners.delete(type);
    // Same reason in reverse: a row nothing can refresh must not stay on screen.
    this.#options.publish(type);
  }

  /**
   * Drop everything an extension contributed.
   *
   * Called when the host that ran it is gone. Leaving the rows would be the
   * agent relay's "confident lie" in another costume: a tree on screen that
   * nothing can refresh and whose clicks reach nobody.
   */
  forget(extension: string): void {
    for (const [type, contribution] of [...this.#owners]) {
      if (contribution.extension === extension) {
        this.#owners.delete(type);
        this.#options.publish(type);
      }
    }
  }

  list(): readonly Contribution[] {
    return [...this.#owners.values()];
  }

  changed(type: string): void {
    if (this.#owners.has(type)) this.#options.publish(type);
  }

  async children(type: string, parent: string | undefined): Promise<readonly TreeItem[]> {
    const contribution = this.#owners.get(type);
    // A component view has no provider to ask — its rows are its own business,
    // inside the page. Answering `[]` rather than asking anyway keeps the child
    // from being woken for a question it cannot answer.
    if (contribution === undefined || contribution.kind !== 'tree') return [];
    return this.#options.read(contribution.extension, type, parent);
  }

  /**
   * A row was clicked — **attributed to the extension that contributed it**.
   *
   * D14. `TreeItem.command` used to be documented as invoked with
   * `{kind:'user'}`, and `authorize` returns an unconditional ALLOW for that. So
   * an extension that can contribute a tree could put ANY command id in a row
   * and have it run with full user trust, including commands its own grant
   * denies — a hole in the grant model M1 spent a phase building, opened by the
   * one place where the user really did click something.
   *
   * The click is the user's; the id behind it is the extension's, and the user
   * cannot see it. So the extension is the caller, and a contribution that wants
   * a privileged verb declares the permission for it like anything else.
   *
   * A click on a view nobody owns does nothing. Guessing a caller in order to
   * run it anyway is the failure this method exists to prevent.
   */
  async activate(type: string, command: { id: string; args?: unknown }): Promise<void> {
    await this.invoke(type, command.id, command.args);
  }

  /**
   * The same gesture, for a caller that needs the answer.
   *
   * A tree row's click is a gesture and discards its result; a contributed
   * **component** (ADR 0033) is a UI that has to show what happened — a created
   * task, a refused one, a list of suggestions. So this is `activate` with the
   * value kept, and deliberately the same method underneath: the attribution
   * rule above is the thing that must not have two implementations, because the
   * second one is where it would quietly become `{kind:'user'}`.
   *
   * A view nobody owns answers `undefined` and runs nothing, for the reason
   * `activate` gives.
   */
  async invoke(type: string, command: string, args?: unknown): Promise<unknown> {
    const contribution = this.#owners.get(type);
    if (contribution === undefined) return undefined;
    const caller: Caller = { kind: 'extension', id: extensionId(contribution.extension) };
    return this.#options.invoke(command, args, caller);
  }
}
