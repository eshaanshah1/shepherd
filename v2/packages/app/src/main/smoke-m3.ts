import { app, type BrowserWindow } from 'electron';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { runGit } from '@shepherd/platform-darwin';
import { flagValue } from './bootstrap.ts';
import { sessionId as toSessionId } from '@shepherd/sdk';
import { check, die, say, waiter } from './smoke-support.ts';
import type { SessionHostLike } from './session-bridge.ts';
import type { M1SmokeOptions } from './smoke-m1.ts';

/** A task's session, as `tasks.list` reports it. */
interface TaskSessionDTO {
  readonly id: string;
  readonly role: string;
  readonly pane?: string;
}

/**
 * The extension's data dir, from a task root. `<dataDir>/<slug>` is the root, so
 * its parent is where `.prompts` lives — derived rather than re-resolved,
 * because this smoke must not own a second opinion about that path.
 */
function supportTasksDir(taskRoot: string): string {
  return join(taskRoot, '..');
}

/**
 * M3: a task is real work on disk, and it survives being shelved.
 *
 * Driven through the **control socket**, not through the extension directly —
 * that is the transport the CLI and an agent use (§7b makes the CLI the agent
 * API), and a second path that happened to work would say nothing about the one
 * that ships. Same argument as `smoke:m2` posting real HTTP to `hooks.sock`.
 *
 * The one asserted SILENCE is creating a task: it is work the user asked for,
 * so it must not alert them about itself. M2's most valuable assertions were all
 * of that shape.
 */

export interface M3SmokeOptions extends M1SmokeOptions {
  readonly alerts: () => readonly unknown[];
}

export function isM3Options(options: Partial<M3SmokeOptions>): options is M3SmokeOptions {
  return typeof options.controlSocket === 'string' && typeof options.alerts === 'function';
}

export async function runM3Smoke(
  win: BrowserWindow,
  host: SessionHostLike,
  options: M3SmokeOptions,
): Promise<void> {
  const repo = flagValue(process.argv, '--shepherd-m3-repo');
  if (repo === undefined) die('no --shepherd-m3-repo');
  const repo2 = flagValue(process.argv, '--shepherd-m3-repo2');
  if (repo2 === undefined) die('no --shepherd-m3-repo2');
  /**
   * The repo's own name, which is what a `#` mention is matched against.
   *
   * The picker filters on the NAME rather than the path around it — a home
   * directory alone supplies most letters of most words — so this is the query
   * the composer step types. Same derivation `repoName` makes, and the
   * provisioning assertion further down re-uses it.
   */
  const repoBase = repo.split('/').filter((part) => part !== '').pop() ?? '';

  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const body = JSON.stringify({ command, args, caller: { kind: 'device', deviceId: 'local-cli' } });
    const raw = await post(options.controlSocket, body);
    const parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: { message?: string } };
    if (parsed.ok !== true) die(`${command}: ${parsed.error?.message ?? raw}`);
    return parsed.value;
  };

  const until = waiter(60_000);

  /**
   * --- 0. a worktree hook for this repo, set through the same transport.
   *
   * The unit tests own everything about how a hook is chosen and how its
   * failure is reported. What no unit test can say is that a real `/bin/bash`
   * ran in a real worktree — every one of them fakes `ProcessAPI`, which is the
   * seam this asserts is actually wired. The script writes a file `git worktree
   * add` could not have produced, so the check below cannot pass by accident.
   */
  await invoke('worktreeHook.set', { repo, script: 'echo hooked > HOOKED.txt' });

  /**
   * --- 0b. a SET hook over both repos, through the same transport.
   *
   * The unit tests own matching, ordering and failure. What no unit test can say
   * is that a real `/bin/bash` ran at a real task root with both worktrees beside
   * it — every one of them fakes `ProcessAPI`. The script writes what it found,
   * so the check below cannot pass by accident.
   */
  await invoke('worktreeHook.set', {
    repos: [repo, repo2],
    script: 'echo "$HOOK_REPOS" > WIRED.txt',
  });

  /**
   * --- 0c. the quick tier is an OFFLINE stub, so naming needs no network.
   *
   * `diagnostics` registers it in a dev build and this selects it by id — which is
   * the real configuration verb (§7c: "the user's configured default"), not a hook
   * that exists for the test. Without this the naming call would be a real ~6s
   * vendor CLI invocation, and a smoke that needed an account is a smoke nobody
   * can run.
   */
  const quick = (await invoke('agents.quickModel', {
    kind: 'diagnostics.stub-agent',
    model: 'stub',
  })) as { kind?: string };
  check(quick.kind === 'diagnostics.stub-agent', `the quick tier is the stub: ${quick.kind ?? 'none'}`);

  /**
   * --- 1. create a task with a real repo, through the real transport.
   *
   * **No `title`**, and that is the case being smoked: a title that is present is
   * one a person typed, and it wins and suppresses the ask. Sending one here
   * would mean this never exercised naming at all.
   */
  const created = (await invoke('tasks.create', {
    brief: 'Provisioned by the m3 smoke, with a brief long enough to be worth naming.',
    repos: [{ path: repo, name: 'api' }],
  })) as { id: string; slug: string; title: string };
  // Capped at 72 with an ellipsis, because this becomes a tab title and a
  // brief's first line is occasionally a paragraph.
  check(
    created.title === 'Provisioned by the m3 smoke, with a brief long enough to be worth namin…',
    `a task opens on its own brief, capped: ${created.title}`,
  );
  /**
   * **The slug is MINTED, and owes nothing to what was typed.**
   *
   * This is the property the whole design rests on: because no directory and no
   * branch is named after the brief, nothing has to wait for a model to answer.
   * A slug that echoed the brief here would mean the old coupling was back.
   */
  check(
    /^[a-z]+-[a-z]+(-\d+)?$/.test(created.slug),
    `create mints a slug that owes nothing to the brief: ${created.slug}`,
  );
  check(
    !created.slug.includes('provisioned') && !created.slug.includes('smoke'),
    `and no word of the brief is in it: ${created.slug}`,
  );

  // --- 2. provisioning is OPTIMISTIC, so the worktree lands after the answer.
  const listed = (await until(
    'the worktree to land',
    async () => ((await invoke('tasks.list')) as { id: string; root: string }[]).find((t) => t.id === created.id),
    // BOTH, because they land in that order: the worktree is `git worktree add`
    // and the root is synthesized from what landed, a beat later. Waiting on the
    // first and asserting the second is a race that passes on the timing of the
    // day — it failed once here for an unrelated reason and blamed the wrong
    // thing, which is what a racy gate always does.
    (task) => task !== undefined && existsSync(join(task.root, 'api', '.git')) && existsSync(join(task.root, 'CLAUDE.md')),
  )) as { root: string };
  const worktree = join(listed.root, 'api');
  check(existsSync(join(listed.root, 'CLAUDE.md')), 'the generated CLAUDE.md exists');
  check(
    readFileSync(join(listed.root, 'CLAUDE.md'), 'utf8').includes('api/'),
    'the CLAUDE.md carries the repo map — the only one loaded at session start',
  );
  say('ok — the worktree and the task root are on disk');

  /**
   * The model's name reaches the LABEL, and nothing else.
   *
   * The two halves are asserted together because that is the correlation this
   * file exists for: a unit test that supplies the name and reads it back cannot
   * discover that the title moved while the directory stayed put — or that it
   * did not.
   */
  const settled = await until(
    'the model’s name to land on the title',
    async () =>
      ((await invoke('tasks.list')) as { id: string; slug: string; title: string }[]).find(
        (task) => task.id === created.id,
      ),
    (task) => task?.title === 'Stub Named This',
  );
  check(settled?.title === 'Stub Named This', `the model's answer became the title: ${settled?.title ?? 'none'}`);
  check(
    settled?.slug === created.slug,
    `and the folder did not move: ${settled?.slug ?? 'none'} was ${created.slug}`,
  );
  const branch = await head(worktree);
  check(branch === created.slug, `the branch is the minted name, not the model's: ${branch}`);
  check(
    listed.root.endsWith(created.slug),
    `and so is the worktree directory: ${listed.root}`,
  );
  check(
    readFileSync(join(listed.root, 'CLAUDE.md'), 'utf8').includes('shepherd task rename-branch'),
    'the task root tells the agent it may rename the branch',
  );
  say('ok — the name reached the label, and nothing on disk moved');

  /**
   * The hook ran, in the right directory, before anything else touched it.
   *
   * `until` rather than a bare `existsSync`, for the reason the worktree gate
   * above uses one: provisioning is optimistic. The gate there already waits for
   * the task ROOT, and the root is materialized AFTER the hook by construction —
   * so if this ever needed to wait, the ordering it is meant to prove would
   * already be broken.
   */
  const hooked = join(worktree, 'HOOKED.txt');
  check(existsSync(hooked), 'the worktree hook ran in the new worktree');
  check(readFileSync(hooked, 'utf8').trim() === 'hooked', 'the hook ran under a real shell, not a fake');
  say('ok — the repo’s worktree hook ran before the task root was built');

  /**
   * --- 2b. the generated directories are pre-trusted, so an agent can start.
   *
   * Measured against Claude Code 2.1.226: a directory it has not seen opens on
   * *"Quick safety check: Is this a project you created or one you trust?"* and
   * waits for a keypress. Every task root is by construction a directory that
   * did not exist a second ago, so without this the orchestrator this smoke goes
   * on to spawn is parked on a dialog nobody is sitting in front of.
   *
   * Asserted here rather than only in `trust.test.ts` because the unit tests own
   * the file's SHAPE and this owns the wiring: that the extension is handed a
   * home at all, that it is the throwaway one this run was given, and that the
   * paths written are the ones actually provisioned.
   */
  const home = flagValue(process.argv, '--shepherd-home');
  if (home === undefined) die('no --shepherd-home: this smoke must not write into the real ~/.claude.json');
  const trusted = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
    projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
  };
  // `endsWith`, not `===`: both the literal path and its realpath are written,
  // and on macOS a temp directory is reached through `/var` while its real name
  // is `/private/var`. Either spelling answers the same question.
  const names = (dir: string): string[] =>
    Object.keys(trusted.projects ?? {}).filter((key) => key.endsWith(dir));
  const isTrusted = (dir: string): boolean =>
    names(dir).some((key) => trusted.projects?.[key]?.hasTrustDialogAccepted === true);
  check(isTrusted(listed.root), 'the task root is pre-trusted');
  check(isTrusted(worktree), "the repo's worktree is pre-trusted");
  // And nothing else: the source repo is the user's, and Shepherd has no
  // standing to answer a trust question about a directory it did not create.
  check(names(repo).length === 0, 'the source repo was NOT trusted — only what this app generated');
  say('ok — the generated directories are pre-trusted');


  // --- 2b. the orchestrator started itself, in a real pane, in the task root.
  //
  // §7b: "composer auto-starts the orchestrator". What is asserted is the
  // MECHANISM, not `claude` — this box has no such binary, and a smoke that
  // needed one would be untestable in CI. So: a session exists whose cwd is the
  // task root, the task's record points at it, and the prompt file is GONE,
  // which is only true if the typed line actually ran (`rm -f` precedes the
  // agent, deliberately, so this holds whether or not the agent exists).
  const orchestrated = (await until(
    'the orchestrator session to be recorded',
    async () => ((await invoke('tasks.list')) as { id: string; sessions: TaskSessionDTO[] }[]).find((t) => t.id === created.id),
    (task) => task !== undefined && task.sessions.some((session) => session.role === 'orchestrator'),
  )) as { sessions: TaskSessionDTO[] };
  const orchestrator = orchestrated.sessions.find((session) => session.role === 'orchestrator') as TaskSessionDTO;

  const live = (await until(
    'the pane to report its session',
    async () => (await invoke('sessions.list')) as { id: string; cwd: string; paneId?: string }[],
    (sessions) => sessions.some((session) => session.paneId === orchestrator.pane),
  )) as { id: string; cwd: string; paneId?: string }[];
  const paneSession = live.find((session) => session.paneId === orchestrator.pane) as { id: string; cwd: string };
  check(paneSession.cwd === listed.root, `the agent runs AT THE TASK ROOT: ${paneSession.cwd}`);

  // The placeholder is replaced by the real id, or `tasks.spawn`'s scoping —
  // which resolves an agent's task from its session id — addresses nothing.
  const correlated = (await until(
    'the record to learn the session id',
    async () => ((await invoke('tasks.list')) as { id: string; sessions: TaskSessionDTO[] }[]).find((t) => t.id === created.id),
    (task) => task?.sessions.some((session) => session.id === paneSession.id) === true,
  )) as { sessions: TaskSessionDTO[] };
  check(
    correlated.sessions.some((session) => session.id === paneSession.id),
    `the task points at the live session: ${JSON.stringify(correlated.sessions)}`,
  );

  const prompts = join(supportTasksDir(listed.root), '.prompts');
  check(
    !existsSync(prompts) || readdirSync(prompts).length === 0,
    `the prompt file was consumed by the line that was typed: ${existsSync(prompts) ? readdirSync(prompts).join(', ') : 'no dir'}`,
  );
  say('ok — an agent is running in the task, and its prompt reached it');

  // --- 3. the silence: none of that alerted anybody.
  check(options.alerts().length === 0, `creating a task raised ${options.alerts().length} alert(s)`);
  say('ok — creating a task alerted nobody');

  // --- 4. dirty it in all four ways, then archive and restore.
  appendFileSync(join(worktree, 'README.md'), 'staged\n');
  await runGit('write', ['add', 'README.md'], { cwd: worktree, timeoutMs: 30_000 });
  appendFileSync(join(worktree, 'README.md'), 'unstaged\n');
  rmSync(join(worktree, 'gone.txt'));
  writeFileSync(join(worktree, 'scratch.txt'), 'untracked\n');
  const before = await status(worktree);
  check(before !== '', `the fixture is actually dirty: ${JSON.stringify(before)}`);

  await invoke('tasks.archive', { task: created.id });
  check(!existsSync(worktree), 'the worktree is gone after archiving');

  /*
   * Shelving a task that is still ON SCREEN keeps its tabs and their screens.
   *
   * Asserted here rather than on the close-every-pane path further down, and
   * the difference is the feature's one real limit: closing panes by hand
   * destroys each screen as it goes, so by the time the last one triggers the
   * archive there is nothing left to capture. This is the path the sidebar's
   * checkmark takes.
   *
   * That the capture BEAT the group's close is what makes `history` present at
   * all — a mirror dies with its session, so the wrong order would archive an
   * empty screen and report no fault.
   */
  const shelved = ((await invoke('tasks.list')) as {
    id: string;
    tabs?: { root: string; panes: { history?: string }[] }[];
  }[]).find((task) => task.id === created.id);
  const shelvedTabs = shelved?.tabs ?? [];
  check(
    shelvedTabs.length >= 1,
    `shelving kept the task's tabs: ${JSON.stringify(shelvedTabs.map((tab) => tab.root))}`,
  );
  check(
    shelvedTabs.some((tab) => tab.panes.some((pane) => pane.history !== undefined)),
    `at least one archived pane kept its screen: ${JSON.stringify(shelvedTabs)}`,
  );
  say('ok — a task shelved from the sidebar keeps its tabs and what was on them');

  /*
   * --- 4b. LOOKING at shelved work costs nothing.
   *
   * The claim the snapshot view exists for, and one no unit test can make: a
   * unit test supplies both halves of the correlation, which is exactly how the
   * archive-on-close bug shipped green. Here the app is real, the worktree is a
   * real directory, and a session is a real pty.
   *
   * Both halves are needed. "No new session" alone would pass if the tabs never
   * opened at all; "the tab is on screen" alone would pass if it opened live.
   */
  /*
   * The session IDS, not a count.
   *
   * A count is not stable here: archiving has just killed this task's pty, and
   * whether the reap has landed by the time the sample is taken is a race — the
   * first version of this assertion compared `1` against `0` and called a
   * session's death a session's birth. What must not happen is a NEW id
   * appearing, and that is what an id set says.
   */
  const idsOf = async (): Promise<Set<string>> =>
    new Set(((await invoke('sessions.list')) as { id: string }[]).map((row) => row.id));
  const sessionsBeforeReveal = await idsOf();
  await invoke('tasks.reveal', { task: created.id });

  const readOnlyPanes = await until(
    'the archived tab to be drawn read-only',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelectorAll('[data-readonly="true"]').length`,
      ) as Promise<number>,
    (found) => found > 0,
  );
  check(readOnlyPanes > 0, `the revealed tab is drawn as captured screens: ${readOnlyPanes} pane(s)`);
  check(!existsSync(worktree), 'revealing a shelved task did NOT put its worktree back');
  const started = [...(await idsOf())].filter((id) => !sessionsBeforeReveal.has(id));
  check(started.length === 0, `revealing started no session: ${JSON.stringify(started)}`);
  say('ok — a shelved task is shown from its snapshot, with no worktree and no pty');

  await invoke('tasks.restore', { task: created.id });

  /*
   * And restoring rebuilt the SCREEN without running anything.
   *
   * The staged resume line sits at the prompt, so every restored pane's
   * foreground process is still its shell — an agent would have replaced it.
   * This is the assertion the whole "no trailing newline" rule exists for, and
   * it is only observable in a real pty.
   */
  const restoredRoots = (await until(
    "the restored task's tabs",
    async () => (await invoke('layout.listRoots', { group: `task:${created.id}` })) as { root: string }[],
    (roots) => roots.length >= shelvedTabs.length,
  )) as { root: string }[];
  check(
    restoredRoots.length === shelvedTabs.length,
    `every tab came back: ${JSON.stringify(restoredRoots.map((root) => root.root))}`,
  );
  /*
   * No REAL agent binary ran, which is a claim about this fixture and not about
   * the feature.
   *
   * It used to read "restoring ran no agent", back when the resume line was
   * staged without a newline and deliberately left at the prompt. That is
   * reversed now — the line ends in the Enter press — so what this can still
   * honestly assert is that the stub kind this smoke hires is not `claude`, and
   * therefore that nothing here is talking to a real API. Left in place because
   * a smoke that silently started billing would be worth catching; renamed
   * because the old wording now describes the opposite of the behaviour.
   */
  const running = ((await invoke('sessions.list')) as {
    id: string;
    foregroundProcess?: string;
  }[]).filter((session) => (session.foregroundProcess ?? '').includes('claude'));
  check(running.length === 0, `no real agent binary ran in this fixture: ${JSON.stringify(running)}`);
  // …and it is LIVE now: the panes have ptys and nothing on screen is a
  // captured screen any more. The inverse of the reveal assertions above, which
  // is what makes the pair discriminating rather than two ways of passing.
  const stillReadOnly = (await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-readonly="true"]').length`,
  )) as number;
  check(stillReadOnly === 0, `restoring replaced every captured screen: ${stillReadOnly} left`);
  const relaunched = [...(await idsOf())].filter((id) => !sessionsBeforeReveal.has(id));
  check(relaunched.length > 0, `restoring brought the panes back live: ${JSON.stringify(relaunched)}`);
  say('ok — a restored task comes back live, with its screens replaced by real ptys');

  const after = await until(
    'the work to be replayed',
    () => status(worktree),
    (text) => text === before,
  );
  check(after === before, `round trip: ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  say('ok — the round trip is byte-identical');

  // --- 5. a contributed view is ON SCREEN, read from the real DOM.
  //
  // Asserting main's registry would pass even if the renderer never drew a
  // thing — the same reason m2 reads the badge's DOM rather than main's state.
  // Diagnostics contributes this tree; nothing about the SHELL knows that, which
  // is the property being tested.
  //
  // Read off Home's rows rather than the dock's, because the dock is gone: the
  // takeover triages every contributed tree onto one screen, and a row carries
  // `<view type>:<row id>` so the two trees are still told apart. The claim is
  // unchanged and so is what would falsify it — an extension's rows reaching
  // the real DOM through a shell that has never heard of that extension.
  const rows = await until(
    'the contributed tree to render',
    () =>
      win.webContents.executeJavaScript(
`Array.from(document.querySelectorAll('[data-testid="takeover-row"][data-entry^="diagnostics.tree:"]')).map((el) => el.textContent)`,
      ) as Promise<string[]>,
    (found) => found.length > 0,
  );
  check(rows.some((row) => row.includes('ticks')), `the tree's rows reached the DOM: ${JSON.stringify(rows)}`);
  say('ok — an extension put a view on screen');

  // --- 6. and the TASK tree specifically, carrying the task this smoke made.
  //
  // The point of asserting both: the shell draws a diagnostics tree and a task
  // tree through the same code path, and neither is special-cased in the core.
  // If `tasks` had needed one, the view model would be wrong (sketch §2b).
  const taskRows = await until(
    'the task tree to show this task',
    () =>
      win.webContents.executeJavaScript(
`Array.from(document.querySelectorAll('[data-testid="takeover-row"][data-entry^="tasks.tree:"]')).map((el) => el.textContent)`,
      ) as Promise<string[]>,
    // The row is labelled with the task's TITLE, and the quick model now owns
    // that string — the same answer that named the branch names the row (D18),
    // which is the half of the fix that makes the sidebar readable. Matching
    // `Smoke task` here would be matching the title nobody has any more.
    (found) => found.some((row) => row.includes('Stub Named This')),
  );
  check(taskRows.length > 0, `the task tree rendered: ${JSON.stringify(taskRows)}`);
  say('ok — the task tree drew the task, through the same mechanism');

  // --- 6b. the OTHER extension's component, clicked, changing its own tree.
  //
  // Same argument as asserting both trees: a component that only ever ran in
  // the extension that wrote the mechanism would say nothing about the
  // mechanism. This one runs a command from inside the page and the answer
  // comes back up the same wire the composer's does — and the tree it bumps is
  // a second, independent contribution proving the invoke really happened.
  await until(
    'the diagnostics card to render',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="diagnostics-card"]') !== null`,
      ) as Promise<boolean>,
    (found) => found,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-testid="diagnostics-ping"]').click(), true`,
  );
  const bumped = await until(
    "the card's command to change the tree it does not own",
    () =>
      win.webContents.executeJavaScript(
`Array.from(document.querySelectorAll('[data-testid="takeover-row"][data-entry^="diagnostics.tree:"]')).map((el) => el.textContent)`,
      ) as Promise<string[]>,
    (found) => found.some((row) => row.includes('ticks: 1')),
  );
  check(bumped.some((row) => row.includes('ticks: 1')), `the component's invoke ran: ${JSON.stringify(bumped)}`);
  say('ok — a contributed component ran a command and the answer came back');

  // --- 7. a task created from INSIDE THE APP — the composer (ADR 0033).
  //
  // Everything above went through the control socket, which is the agent's
  // path. This is the human's, and it is asserted in the real DOM for the
  // reason step 5 is: main's registry would report a healthy contribution even
  // if the page had drawn nothing. What it proves end to end is the whole seam
  // — a contributed React component mounted from a NAME, its `invoke` running a
  // command as `shepherd.tasks`, and the answer landing back in the form.
  // ⌘N, as a real key event into the real window — the composer is an OVERLAY
  // (ADR 0033's `surface`), declared by the extension with its own accelerator,
  // so it does not exist in the DOM until somebody asks for it. Sending the
  // keystroke is the only way to assert that the binding works; asserting the
  // component in isolation would pass with the accelerator wired to nothing.
  //
  // ⌘N rather than ⌘T since tabs landed: ⌘T is the shell's New Tab, and the two
  // could not share a key — a menu accelerator is resolved by AppKit before the
  // page sees the keystroke, so the menu item would have deleted the overlay's
  // binding rather than competed with it.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'n', modifiers: ['meta'] });

  const composerSeen = await until(
    'the composer to render',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="task-composer"]') !== null`,
      ) as Promise<boolean>,
    (found) => found,
  );
  check(composerSeen, 'the composer is on screen');

  /**
   * It opens READY TO TYPE, and this is asserted in Chromium because Chromium is
   * where it was wrong.
   *
   * A `contenteditable` reports `tabIndex === -1` there — focusable, but absent
   * from the tabbable order the DOM can be asked about — so the focus trap's walk
   * skipped the only field on the card and focused the `#repo` button under it.
   * ⌘N then opened a composer that swallowed the first thing anybody typed.
   */
  const focused = (await win.webContents.executeJavaScript(
    `document.activeElement?.dataset?.testid ?? null`,
  )) as string | null;
  check(focused === 'composer-brief', `⌘N lands the caret in the brief: ${JSON.stringify(focused)}`);

  /**
   * And ⎋ on a card nobody has written in closes it.
   *
   * Asserted here rather than only in the component's own test because the layer
   * that acts on the key is the shell's `Modal`, and the composer's picker holds a
   * capture-phase listener that can take Escape before it: the two halves of that
   * rule only meet in the running app. The composer is raised again below, so the
   * step this belongs to continues from a card in the same state it would be in.
   */
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  const dismissedEmpty = await until(
    'the composer to close on ⎋',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="task-composer"]') === null`,
      ) as Promise<boolean>,
    (gone) => gone,
  );
  check(dismissedEmpty, '⎋ closes a composer nobody has written in');

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'n', modifiers: ['meta'] });
  const reopened = await until(
    'the composer to come back',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="task-composer"]') !== null`,
      ) as Promise<boolean>,
    (found) => found,
  );
  check(reopened, 'the composer reopens after being dismissed');

  /**
   * Typing into the brief, which is a CONTENTEDITABLE and not a textarea.
   *
   * It changed so a pasted image can render as a pill where it was pasted — an
   * element cannot live inside a `<textarea>`. So there is no `value` setter to
   * call: the text is written as the field's own content and an `input` event
   * announces it, which is the same shape a keystroke produces. React does not
   * own that subtree by design (`PromptField`: rewriting it per keystroke is
   * what breaks undo), so writing it directly is the supported path rather than
   * a way around one.
   *
   * **And it places a CARET**, which is new and is the whole reason this step
   * changed. There is no repo field any more: the repo is named inside the
   * sentence with `#`, and the trigger reads the caret's own text node — so a
   * write that set `textContent` and fired `input` without a selection would
   * exercise none of it and assert against a picker that can never open.
   */
  await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('[data-testid="composer-brief"]');
    // ONE field: the composer's first line names the task, git-commit style, and
    // the rest is the brief — with the repo mentioned in it, where it belongs.
    field.textContent = ${JSON.stringify(
      ['Composed task', 'Created from inside the app. #'].join('\n'),
    )} + ${JSON.stringify(repoBase)};
    const text = field.firstChild;
    const range = document.createRange();
    range.setStart(text, text.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  /*
   * The rows come from `tasks.suggestRepos` (D5) — the point, its default
   * provider, and a command answering the page. TAKING an offered row rather
   * than typing a path is what makes this assert the chain instead of the field,
   * and the repo is findable by NAME because step 1 already used it, so it is in
   * the frecency history this picker opens on.
   */
  const suggested = await until(
    'the repo picker to offer the repo this smoke already used',
    () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-testid="composer-picker-row"]')).map((el) => el.dataset.path)`,
      ) as Promise<string[]>,
    (paths) => paths.includes(repo),
  );
  check(suggested.includes(repo), `the picker consulted the point: ${JSON.stringify(suggested)}`);

  /*
   * ⏎ takes the active row and inserts it as a pill INTO the brief — the real
   * gesture, and the one the keyboard model makes primary. The active row is the
   * first, which is the one the ranker put there.
   */
  await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('[data-testid="composer-brief"]');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);

  /*
   * The pill IS the scope. There is no chip row to read any more — the sentence
   * holds the repo, and `[data-repo-path]` is what the composer itself reads back
   * to build the `repos` array. Asserting the same DOM the component derives from
   * is what makes this catch a pill that renders but carries no path.
   */
  const scoped = await until(
    'the picked repo to become a pill in the brief',
    () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-testid="composer-brief"] [data-repo-path]')).map((el) => el.dataset.repoPath)`,
      ) as Promise<string[]>,
    (paths) => paths.includes(repo),
  );
  check(scoped.includes(repo), `the mention became a pill: ${JSON.stringify(scoped)}`);
  say('ok — `#` named a repo inside the brief and the pill carries its path');

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-testid="composer-create"]').click(), true`,
  );

  // The overlay CLOSES on success — the component said `done()` and the shell
  // acted on it. That is the assertion, and it is stronger than reading a status
  // line: it proves the answer came back to the page AND that the shell's own
  // half of the seam works. (A failed create keeps the form open with what you
  // typed, which is the behaviour that makes this a meaningful signal.)
  const dismissed = await until(
    'the composer to close itself once the task exists',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="task-composer"]') === null`,
      ) as Promise<boolean>,
    (gone) => gone,
  );
  check(dismissed, 'the composer dismissed itself after creating the task');

  // And it is a real task: the record, its worktree, and its synthesized root.
  // The repo's NAME is derived from the path the picker offered (`repoName`),
  // not supplied the way the CLI supplies it in step 1 — so the worktree is at
  // `<root>/<basename of repo>`. Asserting a hardcoded `api/` here passed the
  // command and failed the filesystem, which is what the first live run showed.
  const composed = (await until(
    'the composed task to provision',
    async () =>
      // Found by ELIMINATION rather than by title: the quick model owns every
      // task's title now, so both tasks in this run are called the same thing and
      // a title lookup would find whichever came first. The one this step made is
      // the one that is not step 1's.
      ((await invoke('tasks.list')) as { id: string; title: string; root: string; repos: { name: string }[] }[]).find(
        (task) => task.id !== created.id,
      ),
    /*
     * BOTH the worktree and the synthesized root, for the reason step 2 records
     * about the very same pair: "they land in that order — the worktree is `git
     * worktree add` and the root is synthesized from what landed, a beat later.
     * Waiting on the first and asserting the second is a race that passes on the
     * timing of the day." This gate waited on `.git` and the `CLAUDE.md` check
     * below was outside it, so it did exactly that, and it duly failed the day
     * the composer got faster.
     */
    (task) =>
      task !== undefined &&
      task.repos.length === 1 &&
      existsSync(join(task.root, task.repos[0]?.name ?? '', '.git')) &&
      existsSync(join(task.root, 'CLAUDE.md')),
  )) as { id: string; root: string; repos: { name: string }[] };
  check(
    composed.repos[0]?.name === repoBase,
    `the picked path became the repo's name: ${JSON.stringify(composed.repos)}`,
  );
  check(existsSync(join(composed.root, 'CLAUDE.md')), 'the composed task root was synthesized too');
  /*
   * Both tasks are named the same thing by the stub model, and they still live in
   * different folders — because a folder is MINTED and a name reaches only the
   * label. `uniqueSlug` is still behind this (D8), now resolving a collision
   * between two random names rather than between two identical titles.
   */
  check(
    composed.root !== listed.root && /\/[a-z]+-[a-z]+(-\d+)?$/.test(composed.root),
    `a second task with the same name got its own minted folder: ${composed.root}`,
  );
  say('ok — a task was created from inside the app, worktree and task root included');

  // --- 8. and it LANDED you in the task — read from the real DOM.
  //
  // A task owns a layout root, so creating one must take you to it: v1's
  // composer behaviour, and the difference between "an agent started" and "an
  // agent started somewhere you cannot see". Asserting main's active root would
  // pass while the window drew the old one, which is the same argument step 5
  // makes about the registry — so this reads the stage the user is looking at.
  //
  // The root id convention (`task:<id>`) is inlined rather than imported: it is
  // public vocabulary, like a command id, and a smoke reaching into an
  // extension's model to agree with itself would assert nothing.
  //
  // Both halves matter. The id says the window is showing THIS task; the count
  // says exactly one root is visible, so a switch that revealed a second root
  // instead of replacing the first is a failure rather than a pass.
  const landed = await until(
    'the window to switch to the composed task’s root',
    () =>
      win.webContents.executeJavaScript(`(() => {
        const roots = Array.from(document.querySelectorAll('.sh-root'));
        const visible = roots.filter((el) => el.style.display !== 'none');
        const active = document.querySelector('.sh-root[data-active="true"]');
        return { active: active === null ? null : active.dataset.root, visible: visible.length };
      })()`) as Promise<{ active: string | null; visible: number }>,
    (state) => state.active === `task:${composed.id}`,
  );
  check(
    landed.active === `task:${composed.id}`,
    `the window is showing the composed task's root: ${JSON.stringify(landed)}`,
  );
  check(landed.visible === 1, `exactly one root is on screen: ${JSON.stringify(landed)}`);
  say('ok — creating a task took the window to it');

  /**
   * And the SIDEBAR agrees about which task that is.
   *
   * This is the whole reason the assertion is here rather than in a unit test.
   * The highlight spans three parties: the `tasks` extension names the root each
   * row stands for (`TreeItem.root`), the layout snapshot carries the active
   * root, and the dock compares them. A unit test can only ever supply both
   * sides of that comparison itself — the both-halves-of-a-correlation trap this
   * file exists for — and what it cannot check is that the root id the extension
   * writes is the same string the kernel puts in the snapshot. That is exactly
   * where the shipped defect lived: the window moved and the highlight did not.
   *
   * A switch NOBODY CLICKED, which is the case a click-driven highlight got
   * wrong. Nothing in this run has touched a sidebar row — the task was created
   * through the composer's command and the window followed the spawn.
   *
   * It USED to assert the rail's highlight following the window (ADR 0035) —
   * `data-selected` on the dock's row. The dock is gone, and with it the idea
   * of a row that is lit while you are somewhere else: the takeover shows one
   * place at a time, so "the row for what is on screen" and "the screen" are
   * the same thing and cannot disagree.
   *
   * What survives is the half that can still be wrong: a task made by the
   * composer reaches the shell without anyone telling it to, exactly ONCE.
   * Matched on the row's `data-entry` — `<view type>:<row id>` — rather than on
   * a count, because "some row appeared" would pass on the wrong one.
   *
   * The band naming the task you entered is the ADR-0035 claim in the new
   * shape, and `smoke:takeover` is where it is asserted.
   */
  const composedRows = await until(
    'the task the composer made to reach the shell',
    () =>
      win.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="takeover-row"], [data-testid="takeover-card"]'));
        return rows.map((el) => el.dataset.entry);
      })()`) as Promise<readonly string[]>,
    (entries) => entries.some((entry) => entry === `tasks.tree:${composed.id}`),
  );
  check(
    composedRows.filter((entry) => entry === `tasks.tree:${composed.id}`).length === 1,
    `the shell lists the composed task exactly once: ${JSON.stringify(composedRows)}`,
  );
  say('ok — a task composed in the app reached the shell nobody told');

  /**
   * --- 8b. a task can hold a SECOND TAB, and the first tab closing is not the
   * task closing.
   *
   * Two claims that no unit test can make, for the reason the step below it
   * exists: they are about the real bus, the real layout store and the real
   * daemon holding the ptys.
   *
   *   - **switching tabs keeps every session.** Every root is mounted and
   *     hidden, so a switch must not tear a pane down — a torn-down pane is a
   *     released terminal and then, on the way back, a SECOND pty. v1's remount
   *     lesson, and a unit test that renders one root cannot see it.
   *   - **closing one tab does not archive the task.** `tasks` archives when it
   *     hears a pane group closed; before `groupEmpty` it heard the anchor's id
   *     and shelved the task while an agent ran on in tab 2. The unit tests for
   *     it supply both halves of that correlation, which is precisely the shape
   *     that hid the archive-on-close bug the step below is about.
   */
  const tab = (await invoke('layout.newTab', { group: `task:${composed.id}` })) as { root?: string };
  check(
    typeof tab.root === 'string' && tab.root.startsWith(`task:${composed.id}/`),
    `newTab minted a root in the task's group: ${JSON.stringify(tab)}`,
  );
  const secondTab = String(tab.root);

  /*
   * THIS GROUP's sessions, not the app's session count.
   *
   * A global count is not the claim and cannot be: other tasks in this smoke are
   * still opening panes of their own, so a count taken here races them and would
   * fail (or pass) for reasons that have nothing to do with tabs. What has to
   * survive a switch is the pty behind each of these two tabs.
   *
   * Waited for FIRST: the pane is minted by the command and its session is
   * created by the renderer when it mounts, so reading straight after `newTab`
   * measures the moment before the tab has a terminal at all.
   */
  const groupSessions = async (): Promise<readonly (string | null)[]> =>
    ((await invoke('layout.listRoots', { group: `task:${composed.id}` })) as {
      root: string;
      focusedSession: string | null;
    }[])
      .sort((a, b) => a.root.localeCompare(b.root))
      .map((root) => root.focusedSession);

  const beforeSwitch = await until(
    "both tabs' sessions to exist",
    groupSessions,
    (sessions) => sessions.length === 2 && sessions.every((id) => id !== null),
  );
  await invoke('layout.switchRoot', { root: `task:${composed.id}` });
  await invoke('layout.switchRoot', { root: secondTab });
  const afterSwitch = await groupSessions();
  check(
    afterSwitch.length === (beforeSwitch as readonly (string | null)[]).length &&
      afterSwitch.every((id, index) => id === (beforeSwitch as readonly (string | null)[])[index]),
    `switching tabs kept both tabs on the SAME ptys (${JSON.stringify(beforeSwitch)} -> ${JSON.stringify(afterSwitch)})`,
  );
  say('ok — a hidden tab keeps its ptys');

  /**
   * --- the OSC title reaches a tab NOBODY is looking at.
   *
   * Here rather than in a unit test because a suspended pane DETACHES from its
   * session, so every layer between the pty and the tab strip has to carry this
   * without an attachment. A test that fed the store directly would pass with
   * the whole transport missing, which is the shape that hid the
   * archive-on-close bug.
   *
   * Switched AWAY first, deliberately: the claim is about a background tab.
   */
  const secondSession = (
    (await invoke('layout.listRoots', { group: `task:${composed.id}` })) as {
      root: string;
      focusedSession: string | null;
    }[]
  ).find((root) => root.root === secondTab)?.focusedSession;
  check(typeof secondSession === 'string', `the second tab has a session: ${String(secondSession)}`);

  await invoke('layout.switchRoot', { root: `task:${composed.id}` });

  const labelOf = async (root: string): Promise<string> =>
    (
      (await invoke('layout.listRoots', { group: `task:${composed.id}` })) as {
        root: string;
        label: string;
      }[]
    ).find((each) => each.root === root)?.label ?? '';

  /*
   * Typed as INPUT: the shell runs it and the OSC arrives as output, which is
   * the road a real program's title travels. Retried by `until` rather than
   * written once, because the write races the renderer finishing its suspend
   * and a line typed into a pane mid-teardown reaches a shell that is not
   * reading yet.
   */
  await until(
    "the background tab's label to follow its OSC title",
    async () => {
      host.write(toSessionId(String(secondSession)), `printf '\\033]2;osc-smoke\\007'\n`);
      return await labelOf(secondTab);
    },
    (label) => label === 'osc-smoke',
  );
  say('ok — a background tab follows its OSC title');

  for (;;) {
    const closed = (await invoke('layout.close', { root: secondTab }).catch(() => null)) as {
      wasLastPane?: boolean;
    } | null;
    if (closed === null || closed.wasLastPane === true) break;
  }
  const stillRunning = ((await invoke('tasks.list')) as { id: string; lifecycle: string }[]).find(
    (t) => t.id === composed.id,
  );
  check(
    stillRunning?.lifecycle === 'running',
    `closing one tab left the task running: ${JSON.stringify(stillRunning)}`,
  );
  say('ok — one tab closing is not the task closing');

  // --- 9. and closing its LAST tab's panes FINISHES it.
  //
  // The one step whose absence shipped a bug: the archive-on-close was wired to
  // `session.exit`, counting the task's own recorded panes down to zero, and
  // pane ids are regenerated when a layout is restored — so after a relaunch
  // the record named panes that did not exist, the count never reached zero,
  // and closing the last pane of a task did nothing at all. Every unit test
  // passed, because every one of them emitted an exit for a pane the record
  // agreed with. This closes the root the way ⌘W's last press does and asks the
  // record what it thinks, which is the only version of the question that
  // spans the bus.
  // Through `layout.close`, one pane at a time — which is ⌘W's own path and
  // the only one that fires `onLastPaneClosed`. `layout.closeRoot` deliberately
  // drains the root through `store.close` instead, precisely so that tearing a
  // root down does not fire the last-pane handler at itself; using it here
  // would test a path the keyboard never takes.
  for (;;) {
    const closed = (await invoke('layout.close', { root: `task:${composed.id}` }).catch(() => null)) as {
      wasLastPane?: boolean;
    } | null;
    if (closed === null || closed.wasLastPane === true) break;
  }
  /**
   * Closing every pane **shelves the work and leaves the task active.**
   *
   * This asserted `lifecycle === 'archived'` and had to change with the design:
   * closing your last pane used to ship the task, which is the app deciding you
   * were finished. Shipping is a button now. What the gesture still does is free
   * the disk — a live worktree measured 838 MB against 16 KB for every shipped
   * task combined — so `shelvedAt` and the snapshot are what to wait for.
   *
   * Worth having in the SMOKE rather than only in units: this trigger is the one
   * that shipped broken with a green unit suite, because every unit test supplied
   * both halves of the pane correlation it got wrong.
   */
  const finished = (await until(
    'the composed task to shelve its work',
    async () =>
      ((await invoke('tasks.list')) as { id: string; lifecycle: string; shelvedAt?: number }[]).find(
        (t) => t.id === composed.id,
      ),
    (task) => task?.shelvedAt !== undefined,
  )) as { lifecycle: string; shelvedAt?: number; archives?: unknown[] };
  check(
    finished.shelvedAt !== undefined,
    `closing the task's panes shelved its work: ${JSON.stringify(finished)}`,
  );
  check(
    finished.lifecycle === 'running',
    `and left it ACTIVE rather than shipping it: ${JSON.stringify(finished.lifecycle)}`,
  );
  say('ok — closing a task frees its disk without shipping it');

  /*
   * And shipping IS available, as the deliberate gesture — the verb the row's
   * hover button runs. Its work is already shelved, so this is the lifecycle half
   * on its own, which is exactly the split being tested.
   */
  await invoke('tasks.archive', { task: composed.id });
  const shipped = (await invoke('tasks.list')) as { id: string; lifecycle: string }[];
  check(
    shipped.find((t) => t.id === composed.id)?.lifecycle === 'archived',
    `shipping it explicitly moved it: ${JSON.stringify(shipped.find((t) => t.id === composed.id))}`,
  );
  say('ok — shipping is a gesture, not a side effect');

  /**
   * --- 9. two repos, provisioned concurrently, wired by one set hook.
   *
   * The set hook runs AFTER `materializeTaskRoot`, so — unlike the repo hook
   * above — the task-root gate does not already prove it has run, and this needs
   * its own wait.
   *
   * LAST, and that placement is load-bearing. The quick-model stub names every
   * task the same thing, so the composer's assertions find their task by that
   * name and pin the `-2` its slug collides into; a two-repo task created before
   * them takes both the name and the suffix, and the composer gate then times out
   * against a task it never made. Anything added here goes after them.
   */
  const pair = (await invoke('tasks.create', {
    title: 'Smoke pair',
    brief: 'Two repos, one set hook.',
    repos: [
      { path: repo, name: 'api' },
      { path: repo2, name: 'web' },
    ],
  })) as { id: string; slug: string };

  const pairListed = (await until(
    'both worktrees and the set hook to land',
    async () => ((await invoke('tasks.list')) as { id: string; root: string }[]).find((t) => t.id === pair.id),
    (task) =>
      task !== undefined &&
      existsSync(join(task.root, 'api', '.git')) &&
      existsSync(join(task.root, 'web', '.git')) &&
      existsSync(join(task.root, 'WIRED.txt')),
  )) as { root: string };

  /**
   * `HOOK_REPOS` named both worktrees.
   *
   * Compared as a SET: the order is the key's (sorted SOURCE paths), which for two
   * `mkdtemp` directories depends on their random suffixes rather than on anything
   * this file controls. The ordering rule itself is owned by `matchSets`' unit
   * tests; what only a real run can say is that both paths reached a real shell.
   */
  const wired = readFileSync(join(pairListed.root, 'WIRED.txt'), 'utf8').trim().split('\n');
  check(
    JSON.stringify([...wired].sort()) ===
      JSON.stringify([join(pairListed.root, 'api'), join(pairListed.root, 'web')].sort()),
    `HOOK_REPOS named both worktrees: ${wired.join(', ')}`,
  );
  const pairClaudeMd = readFileSync(join(pairListed.root, 'CLAUDE.md'), 'utf8');
  check(pairClaudeMd.includes('api/') && pairClaudeMd.includes('web/'), 'the generated CLAUDE.md carries both repos');
  // The repos provision concurrently, so this is the claim that `landed` is read
  // back by index rather than by whichever git finished first.
  check(
    pairClaudeMd.indexOf('api/') < pairClaudeMd.indexOf('web/'),
    'the repo map is in the TASK’s order, not whichever git finished first',
  );
  say('ok — both repos provisioned and the set hook ran at the task root');

  /**
   * --- 12. the settings screen: a takeover that keeps every pty, and a theme
   * that moves BOTH halves.
   *
   * Everything here is a claim no unit test can make. The renderer's own tests
   * mount `SettingsScreen` against a fake bridge; this drives the real command
   * through the real socket, reads the real DOM, and — the part that matters —
   * asserts the panes underneath are the SAME sessions afterwards. A conditional
   * mount around the stage would pass every renderer test and release a pty here.
   */
  const sessionsBefore = ((await invoke('sessions.list')) as { id: string }[]).map((row) => row.id).sort();
  check(sessionsBefore.length > 0, `there are panes to cover: ${sessionsBefore.length}`);

  await invoke('window.settings', { open: true });
  const onScreen = await until(
    'the settings screen to render',
    () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-testid="settings-nav-item"]')).map((el) => el.textContent)`,
      ) as Promise<string[]>,
    (found) => found.length > 0,
  );
  check(onScreen.some((item) => item.includes('General')), `the nav drew its sections: ${JSON.stringify(onScreen)}`);
  // Both consumers are in the nav, which is what makes the seam real rather than
  // a paragraph: one page of specs, one page that is an extension's component.
  check(
    onScreen.some((item) => item.includes('Models')) && onScreen.some((item) => item.includes('Worktree hooks')),
    `both contributed pages are listed: ${JSON.stringify(onScreen)}`,
  );
  say('ok — the settings screen took over the window');

  await invoke('settings.set', { key: 'shepherd.theme', value: 'light' });
  const painted = await until(
    'the light theme to reach the chrome AND the grid',
    () =>
      win.webContents.executeJavaScript(
        `(() => {
          const root = document.documentElement;
          // The GRID's colour, read where the DOM actually carries it. NOT
          // getComputedStyle on .xterm-screen: xterm paints its background on a
          // canvas, so that element is transparent and computes to black whatever
          // the palette is -- a probe that fails on a working app. The pane head
          // publishes the grid's own colour as a custom property, and its whole
          // point is that the head and the grid cannot differ.
          // (No backticks in here: this is inside a template literal.)
          const pane = document.querySelector('[data-pane-title-surface]');
          return {
            theme: root.dataset.theme ?? null,
            surface: root.style.getPropertyValue('--sh-surface').trim(),
            grid: pane === null ? null : getComputedStyle(pane).getPropertyValue('--sh-pane-title-bg').trim(),
            // No TS cast here: this string is evaluated as plain JS in the page.
            luminance: pane === null ? null : pane.dataset.paneTitleSurface ?? null,
          };
        })()`,
      ) as Promise<{ theme: string | null; surface: string; grid: string | null; luminance: string | null }>,
    (found) => found.theme === 'light',
  );
  check(painted.theme === 'light', `the chrome re-themed: ${JSON.stringify(painted)}`);
  /**
   * The grid too, and this is the assertion the feature is FOR: `theme.ts`'s
   * one-token-map rule, and v1's drift between `Theme.swift` and
   * `writeBaseTheme()`. A light chrome over a near-black grid is the failure.
   */
  check(
    painted.luminance === 'light',
    `the terminal grid re-themed too, and its head measured it: ${JSON.stringify(painted)}`,
  );
  say('ok — light mode reached the chrome and the grid, with no relaunch');

  await invoke('settings.reset', { key: 'shepherd.theme' });
  await invoke('window.settings', { open: false });
  const gone = await until(
    'the settings screen to close',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="settings-screen"]') === null`,
      ) as Promise<boolean>,
    (found) => found,
  );
  check(gone, 'the screen closed');
  const sessionsAfter = ((await invoke('sessions.list')) as { id: string }[]).map((row) => row.id).sort();
  check(
    JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore),
    `every pty survived the takeover: ${JSON.stringify(sessionsBefore)} vs ${JSON.stringify(sessionsAfter)}`,
  );
  say('ok — the panes behind it were never torn down');

  say('smoke: OK m3');
  app.exit(0);
}

/** Which branch a worktree is on. `status`'s neighbour, same shape. */
async function head(cwd: string): Promise<string> {
  const out = await runGit('read', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 30_000 });
  return out.ok ? out.stdout.trim() : '';
}

async function status(cwd: string): Promise<string> {
  const out = await runGit('read', ['status', '--porcelain'], { cwd, timeoutMs: 30_000 });
  return out.ok ? out.stdout.split('\n').filter((l) => l !== '').sort().join('|') : '';
}

function post(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: '/invoke', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
