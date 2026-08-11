// Another member's views, alongside this Mac's own.
//
// The rule under test is that a remote view is not a different KIND of view. It
// is the same `views.list` / `views.children` / row-verb conversation, held with
// a different member — so the only thing this module adds is knowing WHICH
// member a view type belongs to, and saying so on the way past.

import { describe, expect, it, vi } from 'vitest';
import { nullLogger } from '@shepherd/sdk';
import { memberOf, qualify, remoteViews, unqualify } from './remote-views.ts';

describe('a qualified view type', () => {
  it('round-trips through the member that owns it', () => {
    const type = qualify('mac-b', 'tasks.tree');
    expect(memberOf(type)).toBe('mac-b');
    expect(unqualify(type)).toBe('tasks.tree');
  });

  /**
   * A local type must stay untouched, because every existing caller passes one
   * and none of them know this scheme exists.
   */
  it('leaves a local type alone', () => {
    expect(memberOf('tasks.tree')).toBeUndefined();
    expect(unqualify('tasks.tree')).toBe('tasks.tree');
  });

  /**
   * A view type is an extension's own string and can contain anything. Splitting
   * on the FIRST separator would make `tasks.tree` out of `mac-b∷tasks∷tree` and
   * route the rest to a member that does not exist.
   */
  it('survives a view type that contains the separator itself', () => {
    const type = qualify('mac-b', 'weird∷type');
    expect(memberOf(type)).toBe('mac-b');
    expect(unqualify(type)).toBe('weird∷type');
  });
});

describe('remoteViews', () => {
  const members = [
    { memberId: 'mac-b', name: 'Mac B', addrs: ['192.168.0.9:8723'], admittedBy: 'a', admittedAt: 0, updatedAt: 0 },
    // No address: in the net, nowhere to reach. A phone.
    { memberId: 'phone', name: 'Phone', addrs: [], admittedBy: 'a', admittedAt: 0, updatedAt: 0 },
  ];

  const remote = (invokeAt: (member: string, command: string, args: unknown) => Promise<unknown>) =>
    remoteViews({
      members: () => members,
      invokeAt,
      log: nullLogger.child('session'),
    });

  it('lists another member’s views, tagged with whose they are', async () => {
    const views = remote(async (_member, command) =>
      command === 'views.list' ? { views: [{ extension: 'tasks', type: 'tasks.tree', kind: 'tree' }] } : {},
    );

    await views.refresh();
    const listed = views.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe(qualify('mac-b', 'tasks.tree'));
    // The tag is what the sidebar draws its indicator from — a member id alone
    // would make the shell render an opaque uuid at somebody.
    expect(listed[0]?.remote).toEqual({ memberId: 'mac-b', name: 'Mac B' });
  });

  it('asks only members it can actually reach', async () => {
    const asked: string[] = [];
    const views = remote(async (member) => {
      asked.push(member);
      return { views: [] };
    });
    await views.refresh();
    expect(asked).toEqual(['mac-b']);
  });

  /**
   * **The sidebar never waits on the net.** `list` is what the window's
   * `views.list` answers from, and it used to await every member first — so two
   * paired Macs that were switched off (packets dropped, not refused) meant the
   * renderer's sidebar never received its views at all, including this Mac's own.
   * The members' section is allowed to arrive late; the window is not allowed to
   * arrive never.
   */
  it('answers from what the members last said, without waiting for them', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const views = remoteViews({
      members: () => members,
      // A member that is switched off: this never settles.
      invokeAt: async () => await new Promise((resolve) => void (answer = resolve)),
      log: nullLogger.child('session'),
    });

    // Nothing yet — and, crucially, no waiting for it.
    expect(views.list()).toEqual([]);

    answer({ views: [{ extension: 'tasks', type: 'tasks.tree', kind: 'tree' }] });
    await vi.waitFor(() => expect(views.list()).toHaveLength(1));
  });

  /**
   * A late answer is only worth having if somebody is told. The shell re-reads on
   * a nudge and is never pushed to, so the refresh that fills the section in has
   * to raise the same nudge a local extension raises.
   */
  it('nudges when a refresh changes the answer, and stays quiet when it does not', async () => {
    const nudges: number[] = [];
    const views = remoteViews({
      members: () => members,
      invokeAt: async () => ({ views: [{ extension: 'tasks', type: 'tasks.tree', kind: 'tree' }] }),
      changed: () => void nudges.push(1),
      log: nullLogger.child('session'),
    });

    await views.refresh();
    expect(nudges).toHaveLength(1);
    // The same answer again is not news. Without this the nudge the renderer
    // re-reads on would provoke the read that raises the next nudge, forever.
    await views.refresh();
    expect(nudges).toHaveLength(1);
  });

  it('asks the members once, however many readers ask at once', async () => {
    let calls = 0;
    const views = remoteViews({
      members: () => members,
      invokeAt: async () => {
        calls += 1;
        return { views: [] };
      },
      log: nullLogger.child('session'),
    });

    await Promise.all([views.refresh(), views.refresh(), views.refresh()]);
    expect(calls).toBe(1);
  });

  /**
   * One member being asleep must not empty the sidebar. A remote list is a
   * best-effort read of machines that come and go, and a failure there is a
   * missing section rather than a broken window.
   */
  it('drops a member that cannot be reached, and keeps the rest', async () => {
    const views = remoteViews({
      members: () => [
        ...members,
        { memberId: 'mac-c', name: 'Mac C', addrs: ['10.0.0.3:8723'], admittedBy: 'a', admittedAt: 0, updatedAt: 0 },
      ],
      invokeAt: async (member, command) => {
        if (member === 'mac-c') throw new Error('asleep');
        return command === 'views.list' ? { views: [{ extension: 'tasks', type: 't', kind: 'tree' }] } : {};
      },
      log: nullLogger.child('session'),
    });

    await views.refresh();
    expect(views.list().map((v) => v.remote?.memberId)).toEqual(['mac-b']);
  });

  /**
   * The same rule one call along. A member that went to sleep between `list` and
   * its rows would otherwise reject into the renderer's read loop, which walks
   * the trees in order and awaits each — so one asleep member cost every view
   * after it its rows.
   */
  it('answers no rows for a member that cannot be reached, rather than throwing', async () => {
    const views = remote(async () => {
      throw new Error('asleep');
    });
    await expect(views.children(qualify('mac-b', 'tasks.tree'))).resolves.toEqual([]);
  });

  it('routes rows and row verbs to the member that owns the view', async () => {
    const calls: Array<{ member: string; command: string; args: unknown }> = [];
    const views = remote(async (member, command, args) => {
      calls.push({ member, command, args });
      return command === 'views.children' ? [{ id: 'row-1', label: 'A task' }] : undefined;
    });

    const rows = await views.children(qualify('mac-b', 'tasks.tree'), 'parent-1');
    expect(rows).toEqual([{ id: 'row-1', label: 'A task' }]);
    // The type it sends over there is the member's OWN — the qualification is
    // this Mac's bookkeeping and means nothing on the other machine.
    expect(calls[0]).toEqual({
      member: 'mac-b',
      command: 'views.children',
      args: { type: 'tasks.tree', parent: 'parent-1' },
    });

    await views.activate(qualify('mac-b', 'tasks.tree'), { id: 'tasks.reveal', args: { task: 't1' } });
    expect(calls[1]).toEqual({
      member: 'mac-b',
      command: 'tasks.reveal',
      args: { task: 't1' },
    });
  });

  it('refuses to route a local type, which is somebody else’s job', async () => {
    const views = remote(vi.fn());
    expect(views.owns('tasks.tree')).toBe(false);
    expect(views.owns(qualify('mac-b', 'tasks.tree'))).toBe(true);
  });
});
