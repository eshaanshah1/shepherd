import { request } from 'node:http';
import { app, type BrowserWindow } from 'electron';
import { check, die, say, sleep } from './smoke-support.ts';

/**
 * **The takeover, measured rather than described.**
 *
 * Every defect this smoke exists for was a LAYOUT defect, and every one of them
 * was invisible to a unit test: the composer opening behind the band, the
 * terminal's first line clipped under it, the `Ship` button off the right edge.
 * jsdom has no layout, so a test there can assert that an element is in the
 * document and learn nothing about whether a person can see it or click it.
 *
 * So this drives the real app and reads real geometry — `getBoundingClientRect`
 * and `elementFromPoint`, which is the browser's own answer to "what would a
 * click hit". Three questions, asked of every surface:
 *
 *   - **Does chrome overlap content?** The band's bottom edge must be the body's
 *     top edge. Anything less is a gap; anything more is content underneath it.
 *   - **Is anything clipped?** Nothing may extend past the window on any side.
 *   - **Is the top-most thing at a control's centre the control?** That is what
 *     a dead hit target actually is, and no assertion about markup reaches it.
 */

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Reading {
  readonly window: { readonly w: number; readonly h: number };
  readonly boxes: Readonly<Record<string, Box | null>>;
  /** Selector → whether the element at its own centre is itself (or its child). */
  readonly hits: Readonly<Record<string, boolean>>;
  readonly text: string;
}

/** The one script, so a reading is one round trip and one moment in time. */
const READ = (selectors: readonly string[], targets: readonly string[]): string => `
  (() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const boxes = {};
    for (const sel of ${JSON.stringify(selectors)}) boxes[sel] = box(sel);
    const hits = {};
    for (const sel of ${JSON.stringify(targets)}) {
      const el = document.querySelector(sel);
      if (el === null) { hits[sel] = false; continue; }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) { hits[sel] = false; continue; }
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      hits[sel] = at !== null && (el === at || el.contains(at) || at.contains(el));
    }
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      boxes,
      hits,
      text: (document.body.textContent || '').slice(0, 400),
    };
  })()
`;

/** One command over the control socket — the transport an agent uses. */
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

const SURFACES = [
  '.sh-app',
  '.sh-take-band',
  '.sh-take-band .sh-take__head',
  '.sh-plate',
  '.sh-body',
  '.sh-stage',
  '.sh-root[data-active="true"]',
  '.sh-face',
  '.sh-screen',
  '.sh-take',
  '.sh-side',
  '.sh-take__toast',
  '.sh-take__kcard',
  '[data-testid="face-tab"]',
  '[data-testid="takeover-primary"]',
  '[data-testid="takeover-later"]',
  '[data-testid="takeover-row"]',
  '[data-testid="takeover-card"]',
  '.sh-take__home',
];

async function read(
  win: BrowserWindow,
  targets: readonly string[] = [],
): Promise<Reading> {
  return (await win.webContents.executeJavaScript(READ(SURFACES, targets))) as Reading;
}

/** Press a key the way the window's own capture-phase handlers see one. */
async function press(win: BrowserWindow, key: string, modifiers: string[] = []): Promise<void> {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: modifiers as never });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: modifiers as never });
  await sleep(160);
}

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return (await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return false;
      el.click();
      return true;
    })()
  `)) as boolean;
}

const inside = (box: Box, w: number, h: number): boolean =>
  box.x >= -1 && box.y >= -1 && box.x + box.w <= w + 1 && box.y + box.h <= h + 1;

/**
 * Nothing may run off the window.
 *
 * `Ship` did, because the band was a flex row whose items defaulted to
 * `min-width: auto` — a long task name refuses to shrink and pushes everything
 * after it past the edge. The symptom is a control you cannot click, and it only
 * appears at a width nobody tests at.
 */
function assertInWindow(where: string, reading: Reading): void {
  const { w, h } = reading.window;
  for (const [selector, box] of Object.entries(reading.boxes)) {
    if (box === null || box.w === 0) continue;
    check(inside(box, w, h), `${where}: ${selector} is inside the window (${JSON.stringify(box)} in ${w}×${h})`);
  }
}

export async function runTakeoverSmoke(win: BrowserWindow, controlSocket: string): Promise<void> {
  await sleep(1400);

  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const body = JSON.stringify({ command, args, caller: { kind: 'device', deviceId: 'local-cli' } });
    const raw = await post(controlSocket, body);
    const parsed = JSON.parse(raw) as { ok?: boolean; value?: unknown; error?: { message?: string } };
    if (parsed.ok !== true) die(`${command}: ${parsed.error?.message ?? raw}`);
    return parsed.value;
  };

  // ── Home ──────────────────────────────────────────────────────────────────
  {
    const home = await read(win, ['.sh-take__title']);
    check(home.boxes['.sh-take'] !== null, 'home: the triage screen is on screen');
    check(home.boxes['.sh-side'] === null, 'home: there is no rail');
    check(home.boxes['.sh-take-band'] === null, 'home: no band — Home is a layer and keeps the plate');
    check(home.hits['.sh-take__title'] === true, 'home: the title is the top-most thing at its own centre');
    assertInWindow('home', home);
    say(`home: ${JSON.stringify(home.boxes['.sh-take'])} in ${home.window.w}×${home.window.h}`);
  }

  // ── Home's own controls ───────────────────────────────────────────────────
  //
  // The measure is 960 and CENTRED, which is the one piece of geometry on this
  // screen worth asserting: across a 1600px window the numbers on the right of
  // a row end up a hand's width from the name they belong to, and you stop
  // reading rows and start reading two columns.
  {
    const home = await read(win, ['[data-testid="takeover-row"]']);
    const column = home.boxes['.sh-take__home'] ?? null;
    check(column !== null, 'home: the content column is drawn');
    if (column !== null) {
      check(column.w <= 1000, `home: the column keeps its measure (${column.w})`);
      const gap = Math.abs(column.x - (home.window.w - column.x - column.w));
      check(gap <= 2, `home: the column is centred (${column.x} left, ${home.window.w - column.x - column.w} right)`);
    }
    check(home.hits['[data-testid="takeover-row"]'] === true, 'home: a row takes the click');
    assertInWindow('home controls', home);
  }

  // ── Shells: a band in the column, with the panes under it ─────────────────
  {
    await press(win, '0');
    const shells = await read(win, ['[data-testid="takeover-back"]']);
    const band = shells.boxes['.sh-take-band'] ?? null;
    const body = shells.boxes['.sh-body'] ?? null;
    check(band !== null, 'shells: the band is drawn');
    check(body !== null, 'shells: the body is drawn');
    if (band !== null && body !== null) {
      /*
       * THE structural assertion. The band's bottom edge is the body's top
       * edge — not one pixel more (content under chrome) and not one less (a
       * gap). It is the whole difference between furniture and a lid, and it is
       * the only thing that can prove the fix rather than describe it.
       */
      check(band.y === 0, `shells: the band starts at the window's top edge (y=${band.y})`);
      check(
        body.y === band.y + band.h,
        `shells: the body starts where the band ends (band ${band.y}+${band.h}, body ${body.y})`,
      );
      check(band.x + band.w === shells.window.w, 'shells: the band spans the window');
    }
    check(shells.hits['[data-testid="takeover-back"]'] === true, 'shells: the way back is clickable');
    assertInWindow('shells', shells);
    say(`shells: band=${JSON.stringify(band)} body=${JSON.stringify(body)}`);
  }

  // ── The composer, over the band ───────────────────────────────────────────
  //
  // Raised from SHELLS on purpose: this is the exact case that was broken —
  // a contributed screen opening BEHIND chrome, which read as a blank window
  // with a band on top.
  {
    await press(win, 'N');
    const composer = await read(win, ['.sh-screen']);
    const screen = composer.boxes['.sh-screen'] ?? null;
    check(screen !== null, 'composer: the screen is on stage');
    if (screen !== null) {
      // It opened BEHIND the band once, and the symptom was a blank window with
      // chrome on top. `elementFromPoint` is the only assertion that catches it.
      check(composer.hits['.sh-screen'] === true, 'composer: nothing is painted over it');
      check(screen.h > 100, `composer: it has real height (${screen.h})`);
    }
    assertInWindow('composer', composer);
    await press(win, 'Escape');
    await sleep(160);
    const closed = await read(win);
    check(closed.boxes['.sh-screen'] === null, 'composer: escape closes it');
    // …and closing it did NOT also leave the place it was raised from.
    check(closed.boxes['.sh-take-band'] !== null, 'composer: closing it leaves you where you were');
  }

  // ── The switcher, over Home ───────────────────────────────────────────────
  {
    await press(win, 'K', ['cmd']);
    const switcher = await read(win, ['.sh-take__kcard', '.sh-take__kin']);
    check(switcher.boxes['.sh-take__kcard'] !== null, 'switcher: the card is on screen');
    check(switcher.hits['.sh-take__kin'] === true, 'switcher: the query field takes the click');
    assertInWindow('switcher', switcher);
    await press(win, 'Escape');
    await sleep(140);
    const gone = await read(win);
    check(gone.boxes['.sh-take__kcard'] === null, 'switcher: escape closes it');
  }

  // ── The way back ──────────────────────────────────────────────────────────
  //
  // `⌘[`, and NOT Escape. Escape belongs to the terminal: a bare Escape bound
  // here is a key deleted from every agent in the app, which is why the band
  // prints the shortcut it actually uses rather than the one a browser would.
  {
    await press(win, '[', ['cmd']);
    const back = await read(win, ['.sh-take__title']);
    check(back.boxes['.sh-take'] !== null, 'back: ⌘[ returns to Home');
    check(back.boxes['.sh-take-band'] === null, 'back: the band is gone with the place it named');
    check(back.hits['.sh-take__title'] === true, 'back: Home is interactive again');
  }

  // ── H, from anywhere ──────────────────────────────────────────────────────
  {
    await press(win, '0');
    const away = await read(win);
    check(away.boxes['.sh-take'] === null, 'H: the window really left Home first');
    await press(win, 'H');
    const back = await read(win);
    check(back.boxes['.sh-take'] !== null, 'H: goes home from a place');
    assertInWindow('home again', back);
  }

  // ── A TASK, and each of its faces ─────────────────────────────────────────
  //
  // The surfaces the three original symptoms lived on. A task with no repos is
  // enough: the faces resolve their own subject from the id, and what is being
  // measured here is the LAYOUT, which does not care how many worktrees are
  // behind it.
  {
    const created = (await invoke('tasks.create', { title: 'Audit', brief: 'A task to look at.' })) as {
      id?: unknown;
    };
    const made = typeof created.id === 'string' ? created.id : '';
    check(made !== '', 'task: the fixture task was created');
    await sleep(900);

    const listed = await read(win);
    check(listed.text.includes('Audit'), 'task: the row reached Home');

    await win.webContents.executeJavaScript(`
      (() => {
        const rows = [...document.querySelectorAll('[data-testid="takeover-row"]')];
        const row = rows.find((each) => (each.textContent || '').includes('Audit'));
        if (row !== undefined) row.click();
        return row !== undefined;
      })()
    `);
    await sleep(700);

    const band = await read(win, [
      '[data-testid="takeover-back"]',
      '[data-testid="face-tab"]',
      '.sh-take__tname',
    ]);
    const bar = band.boxes['.sh-take-band'] ?? null;
    const body = band.boxes['.sh-body'] ?? null;
    check(bar !== null, 'task: the band is drawn');
    if (bar !== null && body !== null) {
      /*
       * SYMPTOM 2, measured: the terminal's first line was clipped under the
       * band. It cannot be now — the body begins exactly where the band ends,
       * so a pane is laid out in the room that is actually left rather than in
       * the room the window has.
       */
      check(bar.y === 0, `task: the band starts at the window's top edge (y=${bar.y})`);
      check(
        body.y === bar.y + bar.h,
        `task: nothing is under the chrome — body ${body.y} = band ${bar.y}+${bar.h}`,
      );
    }
    /*
     * SYMPTOM 3, measured: `Ship` ran off the right edge, because a flex item's
     * default `min-width: auto` let a long name push everything after it past
     * the window. `assertInWindow` walks every surface including the band's
     * controls.
     */
    assertInWindow('task', band);
    check(band.hits['[data-testid="takeover-back"]'] === true, 'task: the way back is clickable');
    check(band.hits['.sh-take__tname'] === true, 'task: the name is not under anything');
    say(`task: band=${JSON.stringify(bar)} body=${JSON.stringify(body)}`);

    // Every face this build offers, by its own key.
    const faces = (await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('[data-testid="face-tab"]')].map((el) => el.dataset.face)
    `)) as string[];
    check(faces[0] === 'agents', `task: Agents is always the first face (${faces.join(', ')})`);
    say(`task: faces = ${faces.join(', ')}`);

    for (let at = 1; at < faces.length; at += 1) {
      const name = faces[at] ?? '?';
      await press(win, String(at + 1), ['cmd']);
      await sleep(500);
      const on = await read(win, [`[data-testid="face-tab"][data-face="${name}"]`]);
      const face = on.boxes['.sh-face'] ?? null;
      const bandNow = on.boxes['.sh-take-band'] ?? null;
      check(face !== null, `${name}: the face has a body`);
      if (face !== null && bandNow !== null) {
        /*
         * EDGE TO EDGE, as a fact rather than a claim: the document starts where
         * the chrome ends and runs to the bottom of the window. A face drawn as
         * a layer could satisfy every markup assertion and still be 44px short.
         */
        check(face.y === bandNow.h, `${name}: the document starts under the band (${face.y})`);
        check(face.x === 0 && face.w === on.window.w, `${name}: it spans the window`);
        check(
          face.y + face.h === on.window.h,
          `${name}: it reaches the bottom (${face.y}+${face.h} of ${on.window.h})`,
        );
      }
      check(on.hits[`[data-testid="face-tab"][data-face="${name}"]`] === true, `${name}: its tab is clickable`);
      assertInWindow(name, on);
    }

    // …and back to Agents, where the STAGE has the room again.
    await press(win, '1', ['cmd']);
    await sleep(400);
    const agents = await read(win);
    check(agents.boxes['.sh-face'] === null, 'agents: no document — the stage keeps the room');
    const stage = agents.boxes['.sh-stage'] ?? null;
    const bandBack = agents.boxes['.sh-take-band'] ?? null;
    if (stage !== null && bandBack !== null) {
      check(stage.y === bandBack.h, `agents: the stage starts under the band (${stage.y})`);
    }
    assertInWindow('agents', agents);

    /*
     * NO `editor` TAB AND NO `review` TAB.
     *
     * They duplicated the faces — `review` is the Changes face, `editor` is the
     * Files face — and both used to open in the TASK'S OWN pane group, so the
     * strip beside a task's agents carried a second copy of a surface the band
     * already offers. Two places for one idea.
     *
     * Asserted after running both verbs, because "the tab is not there" is only
     * worth anything if the thing that used to create it has been asked to.
     * Read off the STAGE's tab strip, and off the roots the layout actually
     * holds — a tab that exists but is scrolled out of the strip is still a tab.
     */
    await invoke('editor.open', {});
    await invoke('github.review', { task: made });
    await sleep(600);

    const tabs = (await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('.sh-stage [role="tab"]')].map((el) => el.textContent)
    `)) as string[];
    check(
      !tabs.some((label) => /editor|review/i.test(label)),
      `task: no editor or review tab in the strip: ${JSON.stringify(tabs)}`,
    );

    const views = (await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('.sh-root[data-active="true"] [data-view-type]')].map((el) => el.dataset.viewType)
    `)) as string[];
    check(
      !views.includes('editor.workspace') && !views.includes('github.review'),
      `task: neither pane was opened as a tab: ${JSON.stringify(views)}`,
    );
    /*
     * And the same question of the LAYOUT, which is the answer that cannot pass
     * vacuously: an empty strip is what a group of ONE draws, so the DOM check
     * above is satisfied both by "no tab was opened" and by "no strip exists".
     * `layout.listRoots` reports the roots themselves, so a review tab sitting
     * in the group unrendered would still be caught — and the group is asserted
     * non-empty first, or an answer of `[]` would prove nothing at all.
     */
    const group = (await invoke('layout.listRoots', { group: `task:${made}` })) as unknown;
    const roots = Array.isArray(group) ? group : [];
    check(roots.length > 0, `task: its pane group has roots to look at (${roots.length})`);
    const types = roots.flatMap((root) => {
      const listed = (root as { viewTypes?: unknown }).viewTypes;
      return Array.isArray(listed) ? listed.filter((each): each is string => typeof each === 'string') : [];
    });
    check(
      !types.includes('editor.workspace') && !types.includes('github.review'),
      `task: the group holds neither pane: ${JSON.stringify(types)}`,
    );
    say(`task: strip = ${JSON.stringify(tabs)}, group view types = ${JSON.stringify(types)}`);

    // The Later menu, from inside the task.
    await press(win, 'L', ['cmd']);
    const later = await read(win, ['[data-testid="later-option"]']);
    check(later.boxes['.sh-take__kcard'] !== null, 'later: the menu opens over the task');
    check(later.hits['[data-testid="later-option"]'] === true, 'later: an option takes the click');
    assertInWindow('later', later);
    await press(win, 'Escape');
    await sleep(200);
    const closed = await read(win);
    check(closed.boxes['.sh-take__kcard'] === null, 'later: escape closes it and nothing else');
    check(closed.boxes['.sh-take-band'] !== null, 'later: you are still on the task');
  }

  say('takeover: done');
  /*
   * Exit, like every other smoke does at its own end. A smoke that merely stops
   * leaves the app running until the runner's 120s timeout kills it — which
   * reports a non-zero status and reads as a failure with every check green.
   */
  app.exit(0);
}
