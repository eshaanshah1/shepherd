import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import type * as TasksManifest from '@shepherd/ext-tasks/manifest';
import {
  CARD_FACTS_CHANGED_TOPIC_ID,
  CARD_FACTS_POINT_ID,
  GITHUB_COMMANDS,
  TASKS_LIST_COMMAND,
  TASKS_SPAWN_COMMAND,
  TASK_PROVISIONED_POINT_ID,
  githubManifest,
} from './manifest.ts';

/**
 * The typed manifest and the `shepherd` key of `package.json` must not drift —
 * the same trade every extension here makes, and the same test that makes it
 * safe.
 *
 * The id-pinning tests below are the compensation for a rule: one extension may
 * TYPE-import another and may not VALUE-import it, so every id `tasks` owns is a
 * local string constant here. Each assignment below is only legal while the two
 * literals are identical, so a rename in `tasks` stops this building rather than
 * leaving this extension registering into a seam nobody defines.
 */

type TasksCardFactsId = typeof TasksManifest.CARD_FACTS_POINT;
type TasksCardFactsTopic = typeof TasksManifest.CARD_FACTS_CHANGED_TOPIC;
type TasksTaskPointId = typeof TasksManifest.TASK_PROVISIONED_POINT;
type TasksListId = typeof TasksManifest.TASK_COMMANDS.list;
type TasksSpawnId = typeof TasksManifest.TASK_COMMANDS.spawn;

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  shepherd: unknown;
  version: string;
};

describe('the github manifest', () => {
  it('matches the shepherd key of its own package.json, field for field', () => {
    expect(pkg.shepherd).toEqual(githubManifest);
  });

  it('declares the same version as the package', () => {
    expect(githubManifest.version).toBe(pkg.version);
  });

  it('declares only permissions the SDK knows', () => {
    for (const permission of githubManifest.permissions) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('declares network, which is the whole feature', () => {
    expect(githubManifest.permissions).toContain('network');
  });

  it('does NOT declare attention', () => {
    /*
     * A failing check is a condition, not an event: it is always downstream of
     * something that already alerted (an agent pushed, CI ran), and v1's nudges
     * recorded the same rule for the same reason. `agents-core` stays the only
     * writer of agent attention (ADR 0026), and the enforcement is this line
     * being absent from a manifest rather than a convention in a file.
     */
    expect(githubManifest.permissions).not.toContain('attention');
  });

  it('declares every extension whose verbs it invokes', () => {
    // `tasks` owns the point and the task model; `agents-core` answers what each
    // agent is doing, which is what the picker's rows report; `editor` answers
    // what the working tree has changed, which is the no-PR view.
    expect(githubManifest.dependencies).toEqual([
      'shepherd.tasks',
      'shepherd.agents-core',
      'shepherd.editor',
    ]);
  });

  it('spells the cardFacts point exactly as tasks defines it', () => {
    const declaredByTasks: TasksCardFactsId = CARD_FACTS_POINT_ID;
    expect(declaredByTasks).toBe('tasks.cardFacts');
  });

  it('spells the cardFacts nudge topic exactly as tasks defines it', () => {
    // The half a rename would break most quietly: an emit onto a topic nobody
    // listens on is not an error anywhere, and the glyph would simply stop
    // updating.
    const declaredByTasks: TasksCardFactsTopic = CARD_FACTS_CHANGED_TOPIC_ID;
    expect(declaredByTasks).toBe('tasks.cardFacts.changed');
  });

  it('spells the taskProvisioned point exactly as tasks defines it', () => {
    const declaredByTasks: TasksTaskPointId = TASK_PROVISIONED_POINT_ID;
    expect(declaredByTasks).toBe('tasks.taskProvisioned');
  });

  it('spells the tasks commands it invokes exactly as tasks declares them', () => {
    const list: TasksListId = TASKS_LIST_COMMAND;
    const spawn: TasksSpawnId = TASKS_SPAWN_COMMAND;
    expect([list, spawn]).toEqual(['tasks.list', 'tasks.spawn']);
  });

  it('contributes exactly the commands it registers', () => {
    expect(githubManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      GITHUB_COMMANDS.review,
      GITHUB_COMMANDS.sync,
      GITHUB_COMMANDS.prs,
      GITHUB_COMMANDS.pr,
      GITHUB_COMMANDS.diff,
      GITHUB_COMMANDS.open,
      GITHUB_COMMANDS.handToAgent,
      GITHUB_COMMANDS.merge,
      GITHUB_COMMANDS.land,
      GITHUB_COMMANDS.seed,
      GITHUB_COMMANDS.changes,
      GITHUB_COMMANDS.createPr,
    ]);
  });

  it('keeps the answer-a-question verbs out of the palette', () => {
    // `prs`, `pr`, `diff` and `changes` are what the pane asks on its way to
    // drawing something.
    // An untitled command is not in the palette (the SDK documents `title` as
    // exactly that filter), and a "GitHub: Prs" row would run a verb whose whole
    // effect is a return value.
    const untitled = (githubManifest.contributes?.commands ?? [])
      .filter((command) => command.title === undefined)
      .map((command) => command.id);
    expect(untitled).toEqual([
      GITHUB_COMMANDS.prs,
      GITHUB_COMMANDS.pr,
      GITHUB_COMMANDS.diff,
      GITHUB_COMMANDS.changes,
    ]);
  });
});
