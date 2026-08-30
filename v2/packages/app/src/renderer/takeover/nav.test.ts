import { describe, expect, it } from 'vitest';
import { HOME, currentTask, go, home, openingFace, pop, samePlace, withFace, type Place } from './nav.ts';

const task = (id: string, face: Place extends never ? never : 'agents' | 'diff' | 'intent' | 'files' = 'agents'): Place => ({
  kind: 'task',
  id,
  root: `task:${id}`,
  face,
});

describe('the stack', () => {
  it('pushes where you were, so esc returns to what you were reading', () => {
    const nav = go(go(HOME, { kind: 'shells' }), task('relay'));
    expect(nav.at).toEqual(task('relay'));
    expect(pop(nav).at).toEqual({ kind: 'shells' });
    expect(pop(pop(nav)).at).toEqual({ kind: 'home' });
  });

  it('stays on Home at the bottom rather than emptying the window', () => {
    expect(pop(HOME)).toEqual(HOME);
    expect(pop(pop(HOME))).toEqual(HOME);
  });

  it('clears on H, so the next esc does not teleport', () => {
    const deep = go(go(go(HOME, { kind: 'shells' }), task('a')), task('b'));
    expect(deep.stack).toHaveLength(3);
    expect(home()).toEqual(HOME);
  });

  it('does not stack a second copy of where you already are', () => {
    /*
     * The case that buys this: a toast fires for the task on screen. Without
     * it, `esc` would take you from the task to the same task, and the place
     * you actually came from would be one press further away every time.
     */
    const nav = go(HOME, task('relay'));
    const again = go(nav, task('relay'));
    expect(again.stack).toEqual(nav.stack);
    expect(again.at).toEqual(task('relay'));
  });

  it('adopts the incoming face when it lands on the task already open', () => {
    const nav = go(HOME, task('relay'));
    const raised = go(nav, task('relay', 'diff'));
    expect(currentTask(raised)?.face).toBe('diff');
    expect(raised.stack).toEqual(nav.stack);
  });

  it('treats two different tasks as two places', () => {
    expect(samePlace(task('a'), task('b'))).toBe(false);
    expect(samePlace(task('a'), task('a', 'files'))).toBe(true);
    expect(samePlace({ kind: 'home' }, { kind: 'shells' })).toBe(false);
  });
});

describe('a face is not a place', () => {
  it('replaces rather than pushing, so esc leaves the task', () => {
    const nav = withFace(withFace(go(HOME, task('relay')), 'diff'), 'files');
    expect(currentTask(nav)?.face).toBe('files');
    expect(nav.stack).toEqual([{ kind: 'home' }]);
    expect(pop(nav).at).toEqual({ kind: 'home' });
  });

  it('is a no-op anywhere that is not a task', () => {
    expect(withFace(HOME, 'diff')).toEqual(HOME);
    expect(currentTask(HOME)).toBeNull();
  });
});

describe('openingFace', () => {
  it('opens a finished task on what it changed, not on an empty terminal', () => {
    expect(openingFace({ running: false, changed: true })).toBe('diff');
  });

  it('opens everything else on its agents, which is where the work is', () => {
    expect(openingFace({ running: true, changed: true })).toBe('agents');
    expect(openingFace({ running: true, changed: false })).toBe('agents');
    expect(openingFace({ running: false, changed: false })).toBe('agents');
  });
});
