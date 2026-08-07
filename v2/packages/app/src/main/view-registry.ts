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

export interface Contribution {
  readonly extension: string;
  readonly type: string;
}

export class ViewRegistry {
  readonly #options: ViewRegistryOptions;
  /** view type → the extension that contributed it. */
  readonly #owners = new Map<string, string>();

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
  register(extension: string, type: string): void {
    this.#owners.set(type, extension);
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
    for (const [type, owner] of [...this.#owners]) {
      if (owner === extension) {
        this.#owners.delete(type);
        this.#options.publish(type);
      }
    }
  }

  list(): readonly Contribution[] {
    return [...this.#owners].map(([type, extension]) => ({ extension, type }));
  }

  changed(type: string): void {
    if (this.#owners.has(type)) this.#options.publish(type);
  }

  async children(type: string, parent: string | undefined): Promise<readonly TreeItem[]> {
    const owner = this.#owners.get(type);
    if (owner === undefined) return [];
    return this.#options.read(owner, type, parent);
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
    const owner = this.#owners.get(type);
    if (owner === undefined) return;
    const caller: Caller = { kind: 'extension', id: extensionId(owner) };
    await this.#options.invoke(command.id, command.args, caller);
  }
}
