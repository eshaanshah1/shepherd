import { app, type BrowserWindow } from 'electron';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { runGit } from '@shepherd/platform-darwin';
import { flagValue } from './bootstrap.ts';
import { check, die, say, waiter } from './smoke-support.ts';
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

export async function runM3Smoke(win: BrowserWindow, options: M3SmokeOptions): Promise<void> {
  const repo = flagValue(process.argv, '--shepherd-m3-repo');
  if (repo === undefined) die('no --shepherd-m3-repo');

  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const body = JSON.stringify({ command, args, caller: { kind: 'device', deviceId: 'local-cli' } });
    const raw = await post(options.controlSocket, body);
    const parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: { message?: string } };
    if (parsed.ok !== true) die(`${command}: ${parsed.error?.message ?? raw}`);
    return parsed.value;
  };

  const until = waiter(60_000);

  // --- 1. create a task with a real repo, through the real transport.
  const created = (await invoke('tasks.create', {
    title: 'Smoke task',
    brief: 'Provisioned by the m3 smoke.',
    repos: [{ path: repo, name: 'api' }],
  })) as { id: string; slug: string };
  check(created.slug === 'smoke-task', `the slug is derived once: ${created.slug}`);

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

  await invoke('tasks.restore', { task: created.id });
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
  // Diagnostics contributes this tree; nothing about the dock knows that, which
  // is the property being tested.
  const rows = await until(
    'the contributed tree to render',
    () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-view-type="diagnostics.tree"] [data-testid="view-row"]')).map((el) => el.textContent)`,
      ) as Promise<string[]>,
    (found) => found.length > 0,
  );
  check(rows.some((row) => row.includes('ticks')), `the tree's rows reached the DOM: ${JSON.stringify(rows)}`);
  say('ok — an extension put a view on screen');

  // --- 6. and the TASK tree specifically, carrying the task this smoke made.
  //
  // The point of asserting both: the dock draws a diagnostics tree and a task
  // tree through the same code path, and neither is special-cased in the core.
  // If `tasks` had needed one, the view model would be wrong (sketch §2b).
  const taskRows = await until(
    'the task tree to show this task',
    () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-view-type="tasks.tree"] [data-testid="view-row"]')).map((el) => el.textContent)`,
      ) as Promise<string[]>,
    (found) => found.some((row) => row.includes('Smoke task')),
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
        `Array.from(document.querySelectorAll('[data-view-type="diagnostics.tree"] [data-testid="view-row"]')).map((el) => el.textContent)`,
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
  const composerSeen = await until(
    'the composer to render',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="task-composer"]') !== null`,
      ) as Promise<boolean>,
    (found) => found,
  );
  check(composerSeen, 'the composer is on screen');

  // React owns these inputs, so a plain `.value =` is a write it never hears
  // about — the value reverts on the next render and the form submits empty.
  // The native setter plus an `input` event is what a real keystroke looks like
  // from React's side; `focusout` is the event React's `onBlur` is built on.
  await win.webContents.executeJavaScript(`(() => {
    const type = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type(document.querySelector('[data-testid="composer-title"]'), 'Composed task');
    type(document.querySelector('[data-testid="composer-brief"]'), 'Created from inside the app.');
    document.querySelector('[data-testid="composer-title"]').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  })()`);

  // The suggestion comes from `tasks.repoSuggestions` (D5) — the point, its
  // default provider, and a command answering the page. Clicking it rather than
  // typing a path is what makes this assert the chain instead of the field.
  const suggested = await until(
    'the repo picker to offer the repo this smoke already used',
    () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[data-testid="composer-suggestion"]')).map((el) => el.dataset.path)`,
      ) as Promise<string[]>,
    (paths) => paths.includes(repo),
  );
  check(suggested.includes(repo), `the picker consulted the point: ${JSON.stringify(suggested)}`);

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-testid="composer-suggestion"][data-path=${JSON.stringify(repo)}]').click(), true`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-testid="composer-create"]').click(), true`,
  );

  const composedStatus = await until(
    'the composer to report what it created',
    () =>
      win.webContents.executeJavaScript(
        `document.querySelector('[data-testid="composer-status"]').textContent`,
      ) as Promise<string>,
    (text) => text.includes('created'),
  );
  check(
    composedStatus.includes('composed-task'),
    `the answer came back to the page: ${JSON.stringify(composedStatus)}`,
  );

  // And it is a real task: the record, its worktree, and its synthesized root.
  // The repo's NAME is derived from the path the picker offered (`repoName`),
  // not supplied the way the CLI supplies it in step 1 — so the worktree is at
  // `<root>/<basename of repo>`. Asserting a hardcoded `api/` here passed the
  // command and failed the filesystem, which is what the first live run showed.
  const composed = (await until(
    'the composed task to provision',
    async () =>
      ((await invoke('tasks.list')) as { title: string; root: string; repos: { name: string }[] }[]).find(
        (task) => task.title === 'Composed task',
      ),
    (task) =>
      task !== undefined &&
      task.repos.length === 1 &&
      existsSync(join(task.root, task.repos[0]?.name ?? '', '.git')),
  )) as { root: string; repos: { name: string }[] };
  check(
    composed.repos[0]?.name === repo.split('/').filter((s) => s !== '').pop(),
    `the picked path became the repo's name: ${JSON.stringify(composed.repos)}`,
  );
  check(existsSync(join(composed.root, 'CLAUDE.md')), 'the composed task root was synthesized too');
  say('ok — a task was created from inside the app, worktree and task root included');

  say('smoke: OK m3');
  app.exit(0);
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
