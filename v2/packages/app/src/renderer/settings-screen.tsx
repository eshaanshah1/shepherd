import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { IconArrowLeft } from '@tabler/icons-react';
import { Empty, Field, IconButton, Row, SectionLabel, type SelectOption } from '@shepherd/ui';
import { settingChoicesSchema, type SettingSpec, type SettingValue } from '@shepherd/sdk';
import type { SettingsApi, SettingsPageDTO, SettingsSnapshotDTO } from '../shared/index.ts';
import { resolveExtensionUi } from './extension-ui.ts';
import { filterPages } from './settings-filter.ts';
import { SettingRow } from './settings-rows.tsx';

/**
 * The settings screen — a shell-owned frame around pages nobody here understands.
 *
 * What this file decides: the nav order, the search, which page is showing, and
 * that Esc leaves. What it deliberately cannot decide: what a page contains. A
 * spec page is drawn by `SettingRow`; a component page is an extension's own React
 * module resolved by NAME (ADR 0033), handed `invoke`/`done` and nothing else.
 *
 * Two rules that are not cosmetic:
 *
 *   - **Values are re-read on the bridge's change push, never assumed.** The CLI
 *     and an extension are both writers; a screen that trusted its own last write
 *     would be stale the moment somebody typed `shepherd settings` in a pane
 *     behind the window.
 *   - **Whether this screen is open is NOT this component's state.** Main owns it
 *     (`window.settings`), because the same answer feeds `presence.overlay`. This
 *     component is mounted while it is open and calls `onClose` to ask for the
 *     other state; it never assumes it got it.
 */

export interface SettingsScreenProps {
  readonly settings: SettingsApi | null;
  readonly onClose: () => void;
}

export function SettingsScreen({ settings, onClose }: SettingsScreenProps): ReactElement {
  const [snapshot, setSnapshot] = useState<SettingsSnapshotDTO | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  /** Per-key write failures, kept on the row that caused them. */
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const read = useCallback(async () => {
    if (settings === null) return;
    const listed = await settings.list();
    if (listed.ok) setSnapshot(listed.value);
  }, [settings]);

  useEffect(() => {
    void read();
    // Re-read on ANY change, not just the ones this screen made. That is the
    // whole reason the push exists — see the header.
    return settings?.onChanged(() => void read());
  }, [read, settings]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Capture, like every other global key in this app: a terminal behind this
      // screen still has DOM focus in some states, and xterm handles keys on the
      // way down.
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pages = useMemo(() => filterPages(snapshot?.pages ?? [], query), [snapshot, query]);
  /**
   * The showing page: what was chosen if the search still contains it, else the
   * first match. A selection that survived a filter it no longer matches is a nav
   * with nothing highlighted and a body nobody asked for.
   */
  const page = pages.find((candidate) => candidate.id === selected) ?? pages[0];

  const write = async (key: string, value: SettingValue): Promise<void> => {
    if (settings === null) return;
    const result = await settings.set(key, value);
    setErrors((was) => {
      const next = { ...was };
      if (result.ok) delete next[key];
      else next[key] = result.error.message;
      return next;
    });
    // Re-read rather than patching the snapshot locally: the registry decides
    // what a value BECAME (a write equal to the default is stored as nothing),
    // and `isDefault` is its answer, not ours to infer.
    if (result.ok) await read();
  };

  return (
    <section className="sh-settings" data-testid="settings-screen">
      <header className="sh-settings__bar">
        <IconButton
          icon={IconArrowLeft}
          size="sm"
          label="Close settings"
          title="Close settings (Esc)"
          data-testid="settings-back"
          onClick={onClose}
        />
        <h1 className="sh-settings__title">Settings</h1>
        <span className="sh-settings__spacer" />
        <Field
          value={query}
          placeholder="Search settings"
          data-testid="settings-search"
          aria-label="Search settings"
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>

      <div className="sh-settings__body">
        <nav className="sh-settings__nav" aria-label="Settings sections">
          {pages.map((candidate) => (
            <Row
              key={candidate.id}
              role="button"
              tabIndex={0}
              data-testid="settings-nav-item"
              data-page={candidate.id}
              selected={candidate.id === page?.id}
              /*
                No `meta` here, and no owner.

                `Row.meta` is mono (it is for machine-produced text) and shares the
                trailing cell, so in a fixed-width nav it won the space and
                ELLIPSISED the title away: the list read `General / agents-core /
                worktree-hook` — two package names and one section. The nav is a
                list of subjects; which extension owns a page belongs on the page,
                beside its heading.
              */
              onClick={() => setSelected(candidate.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setSelected(candidate.id);
              }}
            >
              {candidate.title}
            </Row>
          ))}
        </nav>

        <div className="sh-settings__page">
          {/* The measure. See `settings.css` — a row is a label/control PAIR, and
              at window width it stops reading as one. */}
          <div className="sh-settings__measure">
          {page === undefined ? (
            <Empty hint="Try a different word, or clear the search.">Nothing matches that search.</Empty>
          ) : (
            page.component !== undefined ? (
              <ComponentPage page={page} settings={settings} />
            ) : (
            <SpecPage
              page={page}
              values={snapshot?.values ?? {}}
              defaults={snapshot?.defaults ?? []}
              errors={errors}
              settings={settings}
              onWrite={write}
              onReset={async (key) => {
                await settings?.reset(key);
                await read();
              }}
            />
            )
          )}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * `shepherd.agents-core` → `agents-core`, and nothing for the kernel's own pages.
 *
 * Drawn beside the page HEADING rather than in the nav: see the nav row's comment.
 */
function ownerLabel(owner: string): string | undefined {
  if (owner === 'shepherd') return undefined;
  const at = owner.lastIndexOf('.');
  return at === -1 ? owner : owner.slice(at + 1);
}

/** The heading of a page, with the extension that contributed it. */
function PageHeading({ page }: { readonly page: SettingsPageDTO }): ReactElement {
  const owner = ownerLabel(page.owner);
  return (
    <div className="sh-settings__heading">
      <SectionLabel role="heading" aria-level={2}>
        {page.title}
      </SectionLabel>
      {owner !== undefined && <span className="sh-settings__owner">{owner}</span>}
    </div>
  );
}

/**
 * A page of SPECS.
 *
 * Separate from `ComponentPage` as a component rather than as a branch inside one,
 * because both of them call hooks: a single component that returned early for a
 * component page would call `useDynamicChoices` conditionally, which React
 * forbids and which breaks the moment a user switches between the two kinds of
 * page.
 */
function SpecPage({
  page,
  values,
  defaults,
  errors,
  settings,
  onWrite,
  onReset,
}: {
  readonly page: SettingsPageDTO;
  readonly values: Readonly<Record<string, SettingValue>>;
  readonly defaults: readonly string[];
  readonly errors: Readonly<Record<string, string>>;
  readonly settings: SettingsApi | null;
  readonly onWrite: (key: string, value: SettingValue) => Promise<void>;
  readonly onReset: (key: string) => Promise<void>;
}): ReactElement {
  const dynamic = useDynamicChoices(page, settings);
  const groups = groupSpecs(page.settings ?? []);

  return (
    <>
      <PageHeading page={page} />
      {groups.map(([group, specs]) => (
        <div className="sh-settings__group" key={group ?? ''}>
          {group !== undefined && <SectionLabel>{group}</SectionLabel>}
          {specs.map((spec) => {
            const resolved = spec.choicesFrom === undefined ? undefined : dynamic[spec.key];
            return (
              <SettingRow
                key={spec.key}
                spec={spec}
                value={values[spec.key] ?? spec.default}
                isDefault={defaults.includes(spec.key)}
                choices={resolved?.choices}
                busy={resolved?.busy ?? spec.choicesFrom !== undefined}
                choicesError={resolved?.error}
                error={errors[spec.key]}
                onChange={(next) => void onWrite(spec.key, next)}
                onReset={() => void onReset(spec.key)}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

/** Rows in declaration order, grouped by `group`, ungrouped ones first. */
function groupSpecs(specs: readonly SettingSpec[]): [string | undefined, SettingSpec[]][] {
  const groups = new Map<string | undefined, SettingSpec[]>();
  for (const spec of specs) {
    const key = spec.group;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [spec]);
    else existing.push(spec);
  }
  return [...groups.entries()];
}

interface DynamicChoices {
  readonly busy: boolean;
  readonly choices?: readonly SelectOption[];
  readonly error?: string;
}

/**
 * The `choicesFrom` seam, resolved when a page is OPENED and not before.
 *
 * That timing is the whole reason it is allowed to exist: asking every extension
 * for its options at startup would activate all of them, which is what
 * `contributes.settings` being static avoids. One page open activates one
 * extension, through the `onCommand:` event it already declares.
 *
 * A failure is kept and reported, never retried in a loop: an extension that is
 * not there will not be there on the second ask either, and a row that says why
 * beats a spinner that never stops.
 */
function useDynamicChoices(
  page: SettingsPageDTO,
  settings: SettingsApi | null,
): Readonly<Record<string, DynamicChoices>> {
  const [state, setState] = useState<Readonly<Record<string, DynamicChoices>>>({});
  /**
   * Keyed by SETTING, not by command — two rows on this page name the same command
   * and must not share its answer. `agents.quickModelChoices` lists agent kinds for
   * one row and model ids for the other, and it tells them apart by the `key` it is
   * asked with; a per-command cache put the kinds in the model row.
   */
  const asks = useMemo(
    () =>
      (page.settings ?? [])
        .filter((spec) => spec.choicesFrom !== undefined)
        .map((spec) => ({ key: spec.key, command: spec.choicesFrom as string })),
    [page],
  );

  useEffect(() => {
    if (settings === null || asks.length === 0) return;
    let live = true;
    setState(Object.fromEntries(asks.map((ask) => [ask.key, { busy: true }])));
    for (const ask of asks) {
      // `{ key }`, always an object: a command's schema is `s.object`, and
      // `s.object` on `undefined` is an `invalid-args` failure — which is what
      // painted both of these rows red as free-text boxes.
      void settings.invoke(page.id, ask.command, { key: ask.key }).then((answer) => {
        if (!live) return;
        setState((was) => ({ ...was, [ask.key]: readChoices(answer) }));
      });
    }
    return () => {
      live = false;
    };
  }, [asks, page.id, settings]);

  return state;
}

/** The answer crossed a port, so it is parsed rather than cast. */
function readChoices(answer: { ok: boolean; value?: unknown; error?: { message: string } }): DynamicChoices {
  if (!answer.ok) return { busy: false, error: answer.error?.message ?? 'the options could not be read' };
  const parsed = settingChoicesSchema.parse(answer.value);
  if (!parsed.ok) {
    return { busy: false, error: 'the extension answered something that is not a list of choices' };
  }
  return { busy: false, choices: parsed.value };
}

/**
 * A component page — ADR 0033's escape hatch, reused whole.
 *
 * The name resolves against the same static table a dock or overlay view uses, so
 * an extension can ask for a UI module and cannot supply one; a name this build
 * has never seen draws an honest empty state rather than nothing at all.
 *
 * `invoke` is bound to this PAGE, and main attributes it to the extension that
 * contributed the page (D14) — the component cannot name a caller, exactly as it
 * cannot in a dock.
 */
function ComponentPage({
  page,
  settings,
}: {
  readonly page: SettingsPageDTO;
  readonly settings: SettingsApi | null;
}): ReactElement {
  const Component = resolveExtensionUi(page.component);
  const props = useMemo(
    () => ({
      invoke: async (command: string, args?: unknown) => {
        if (settings === null) return { ok: false as const, error: { code: 'unavailable', message: 'no bridge' } };
        const result = await settings.invoke(page.id, command, args);
        return result.ok ? { ok: true as const, value: result.value } : { ok: false as const, error: result.error };
      },
      // A settings page has nowhere to go when it is "finished" — it is not a
      // composer over a window, it IS the page. So `done` is a no-op rather than a
      // close: dismissing the whole screen because a form saved would take the
      // user out of settings they may not have finished with.
      done: () => {},
    }),
    [page.id, settings],
  );

  return (
    <>
      <PageHeading page={page} />
      {Component === undefined ? (
        <Empty hint={`${page.owner} contributed “${page.component ?? 'nothing'}”, which this build has no UI for`}>
          This page has no UI in this build.
        </Empty>
      ) : (
        <Component {...props} />
      )}
    </>
  );
}
