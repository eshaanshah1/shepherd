import { describe, expect, it } from 'vitest';
import type { AgentKind } from './kind.ts';
import { modelChoices, resolveDefaultModel } from './models.ts';

/**
 * The model menu and the model it opens on — what the rows say, and which row is
 * already selected.
 */

const kind = (id: string, over: Partial<AgentKind> = {}): AgentKind =>
  ({
    id,
    topics: [],
    capabilities: {},
    reduce: () => ({ kind: 'ignore', why: 'a fixture' }),
    ...over,
  }) as AgentKind;

const claude = kind('claude-code', {
  listModels: () => [
    { id: 'fable', label: 'Fable', note: 'deepest reasoning' },
    { id: 'opus', label: 'Opus', note: 'complex agentic work' },
  ],
  defaultModel: 'opus',
});

describe('modelChoices', () => {
  it('does not repeat the vendor id when there is only one vendor', () => {
    // A row draws its description in the trailing column, so a prefix repeated
    // down the menu costs the space the model's name needs.
    expect(modelChoices([claude])).toEqual([
      { value: 'fable', label: 'Fable', description: 'deepest reasoning' },
      { value: 'opus', label: 'Opus', description: 'complex agentic work' },
    ]);
  });

  it('names the vendor once there are two, because a label alone stops identifying', () => {
    const other = kind('codex', { listModels: () => [{ id: 'opus', label: 'Opus' }] });
    expect(modelChoices([claude, other]).map((row) => row.description)).toEqual([
      'claude-code · deepest reasoning',
      'claude-code · complex agentic work',
      'codex',
    ]);
  });

  it('omits the description entirely rather than sending an empty one', () => {
    // An empty string still reserves the column it is drawn in.
    const bare = kind('bare', { listModels: () => [{ id: 'x', label: 'X' }] });
    expect(modelChoices([bare])).toEqual([{ value: 'x', label: 'X' }]);
  });

  it('answers nothing for a kind that offers no choice', () => {
    expect(modelChoices([kind('opaque')])).toEqual([]);
  });
});

describe('resolveDefaultModel', () => {
  it('takes what the vendor declares when nobody has chosen', () => {
    expect(resolveDefaultModel([claude], null)).toBe('opus');
  });

  it('takes the user’s choice over the vendor’s', () => {
    expect(resolveDefaultModel([claude], 'fable')).toBe('fable');
  });

  it('ignores a stored model the vendor no longer lists', () => {
    // MUTATION TARGET: a retired id reaches `--model` and fails every launch,
    // silently, until somebody opens a settings row that looks fine.
    expect(resolveDefaultModel([claude], 'sonnet-3')).toBe('opus');
  });

  it('ignores a declared default the same kind does not list', () => {
    // A value in no option draws an em dash the user cannot choose again.
    const inconsistent = kind('odd', {
      listModels: () => [{ id: 'a', label: 'A' }],
      defaultModel: 'gone',
    });
    expect(resolveDefaultModel([inconsistent], null)).toBe('a');
  });

  it('falls back to the first model offered, so a kind with no default still yields one', () => {
    const undeclared = kind('undeclared', {
      listModels: () => [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }],
    });
    expect(resolveDefaultModel([undeclared], null)).toBe('first');
  });

  it('answers null when nothing lists a model at all', () => {
    // The caller then sends none; inventing one would be this extension naming a
    // vendor's model.
    expect(resolveDefaultModel([], null)).toBeNull();
    expect(resolveDefaultModel([kind('opaque')], null)).toBeNull();
  });
});
