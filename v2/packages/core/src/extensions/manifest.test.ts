import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@shepherd/sdk';
import { isExtensionIdShape, isVersion, isVersionRange, parseManifest, type ManifestError } from './manifest.ts';

/** The smallest manifest that passes. Every test mutates a copy of this. */
function valid(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'shepherd.tasks',
    name: 'Tasks',
    version: '0.1.0',
    api: '^1.0.0',
    activation: ['onStartup'],
    permissions: ['storage'],
    ...patch,
  };
}

function errors(raw: unknown): readonly ManifestError[] {
  const result = parseManifest(raw, 'user');
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result.error;
}

const fields = (raw: unknown) => errors(raw).map((e) => e.field);
const text = (raw: unknown) => errors(raw).map((e) => e.message).join(' | ');

describe('the happy path', () => {
  it('accepts a minimal manifest and returns it typed', () => {
    const result = parseManifest(valid(), 'builtin');
    expect(result).toEqual({
      ok: true,
      value: {
        id: 'shepherd.tasks',
        name: 'Tasks',
        version: '0.1.0',
        api: '^1.0.0',
        activation: ['onStartup'],
        permissions: ['storage'],
      },
    });
  });

  it('carries dependencies and contributions through unchanged', () => {
    const result = parseManifest(
      valid({
        dependencies: ['shepherd.worktrees'],
        activation: ['onCommand:tasks.create', 'onView:tasks.sidebar'],
        permissions: ['storage', 'sessions', 'agents'],
        contributes: {
          commands: [{ id: 'tasks.create', title: 'New Task', key: 'CmdOrCtrl+Shift+T' }],
          views: [{ id: 'tasks.sidebar', type: 'tree', title: 'Tasks', region: 'sidebar' }],
        },
      }),
      'user',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dependencies).toEqual(['shepherd.worktrees']);
    expect(result.value.contributes?.commands?.[0]?.id).toBe('tasks.create');
    expect(result.value.activation).toEqual(['onCommand:tasks.create', 'onView:tasks.sidebar']);
  });

  it('omits absent optional fields rather than materializing them as undefined', () => {
    // A manifest round-tripped through the store must not grow keys it never had:
    // `'dependencies' in manifest` is how the dependency check reads, and an
    // undefined-valued key answers that question wrong.
    const result = parseManifest(valid(), 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.value, 'dependencies')).toBe(false);
    expect(Object.hasOwn(result.value, 'contributes')).toBe(false);
  });
});

describe('structural failure', () => {
  it('reports the schema path and still names the extension', () => {
    // The reason `manifestSchema` is loose in the string fields: an error a user
    // can act on has to say *which* extension it is about, and a structural parse
    // that fails on `permissions` has no id attached unless the loader adds it.
    const found = errors(valid({ name: 7 }));
    expect(found).toHaveLength(1);
    expect(found[0]?.field).toBe('name');
    expect(found[0]?.id).toBe('shepherd.tasks');
  });

  it('falls back to a placeholder id when the blob has no usable one', () => {
    const found = errors({ name: 'Nameless' });
    expect(found.every((e) => e.id === '<unknown>')).toBe(true);
    expect(found.length).toBeGreaterThan(0);
  });

  it('a non-object is a single rooted error, not a crash', () => {
    for (const raw of [null, undefined, 'shepherd.tasks', 42, []]) {
      const found = errors(raw);
      expect(found).toHaveLength(1);
      expect(found[0]?.field).toBe('<root>');
    }
  });

  it('does not run the semantic checks once the structure is wrong', () => {
    // Semantic checks read fields the schema has already proven present. Running
    // them over a shape that failed would report a second, misleading complaint
    // about a field the reader cannot even see.
    const found = errors({ id: 'no-dots-here' });
    expect(found.some((e) => e.field === 'id' && e.message.includes('reverse-dotted'))).toBe(false);
  });

  it('carries the source, so a malformed BUILT-IN reads as our own bug', () => {
    const result = parseManifest({ id: 'shepherd.tasks' }, 'builtin');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.every((e) => e.source === 'builtin')).toBe(true);
  });
});

describe('id', () => {
  it('requires at least one dot', () => {
    expect(text(valid({ id: 'tasks' }))).toContain('reverse-dotted');
    expect(fields(valid({ id: 'tasks' }))).toEqual(['id']);
  });

  it('rejects whitespace with its own message, since a trailing space is invisible', () => {
    expect(text(valid({ id: 'shepherd.tasks ' }))).toContain('whitespace');
  });

  it('rejects empty segments and an empty id', () => {
    expect(fields(valid({ id: 'shepherd..tasks' }))).toEqual(['id']);
    expect(fields(valid({ id: '' }))).toEqual(['id']);
    expect(fields(valid({ id: '.tasks' }))).toEqual(['id']);
  });

  it('names the bad value, so the message is actionable on its own', () => {
    expect(text(valid({ id: 'tasks' }))).toContain('"tasks"');
  });

  it('accepts deeper namespaces and the punctuation an npm-ish name uses', () => {
    for (const id of ['shepherd.agents.core', 'com.example.my-ext', 'a.b']) {
      expect(parseManifest(valid({ id }), 'user').ok, id).toBe(true);
    }
  });
});

describe('version and api range', () => {
  it('requires major.minor.patch for version', () => {
    for (const version of ['1', '1.0', 'v1.0.0', 'latest', '1.0.x', '']) {
      expect(fields(valid({ version })), version).toEqual(['version']);
    }
  });

  it('accepts a prerelease and build suffix', () => {
    // `0.0.0-dev` is exactly the sentinel a dev build stamps into its own
    // version (v1 shipped that in `project.yml`), so rejecting prereleases would
    // make an unreleased extension unloadable.
    for (const version of ['1.2.3', '0.0.0-dev', '2.0.0-beta.1', '1.0.0+sha.abc']) {
      expect(parseManifest(valid({ version }), 'user').ok, version).toBe(true);
    }
  });

  it('accepts a caret, tilde or exact range for api', () => {
    for (const api of ['^1.0.0', '~1.2.3', '1.0.0', '^0.1.0-dev']) {
      expect(parseManifest(valid({ api }), 'user').ok, api).toBe(true);
    }
  });

  it('rejects a range it cannot read, rather than guessing', () => {
    // Shape only: nothing in this phase compares a range against the host
    // version, so an operator we do not parse must fail here and not silently
    // pass through to a comparison that will read it wrong later.
    for (const api of ['*', '>=1.0.0', '1.x', 'latest', '']) {
      expect(fields(valid({ api })), api).toEqual(['api']);
    }
  });
});

describe('permissions', () => {
  it('rejects an unknown permission, names it, and lists the valid set', () => {
    // The user has to be able to fix this without reading our source.
    const message = text(valid({ permissions: ['storage', 'filesystem'] }));
    expect(message).toContain('"filesystem"');
    for (const permission of PERMISSIONS) expect(message).toContain(permission);
  });

  it('points at the offending element, not the array', () => {
    expect(fields(valid({ permissions: ['storage', 'filesystem'] }))).toEqual(['permissions[1]']);
  });

  it('reports every unknown permission, not just the first', () => {
    expect(fields(valid({ permissions: ['nope', 'storage', 'alsonope'] }))).toEqual([
      'permissions[0]',
      'permissions[2]',
    ]);
  });

  it('accepts the whole known set, including `agents`', () => {
    // `agents` is in the vocabulary in M1, ahead of its M2 implementation, so an
    // extension can declare against a stable set (spec §7c).
    expect(parseManifest(valid({ permissions: [...PERMISSIONS] }), 'user').ok).toBe(true);
  });

  it('accepts an extension that asks for nothing', () => {
    expect(parseManifest(valid({ permissions: [] }), 'user').ok).toBe(true);
  });
});

describe('activation', () => {
  it('accepts the three known forms', () => {
    for (const event of ['onStartup', 'onCommand:tasks.create', 'onView:tasks.sidebar']) {
      expect(parseManifest(valid({ activation: [event] }), 'user').ok, event).toBe(true);
    }
  });

  it('rejects an unknown event naming it and the valid forms', () => {
    const message = text(valid({ activation: ['onLaunch'] }));
    expect(message).toContain('"onLaunch"');
    expect(message).toContain('onCommand:');
  });

  it('rejects an empty suffix — `onCommand:` activates on nothing', () => {
    // An activation event that can never match is an extension that will never
    // load, which is the silent-no-op class this kernel refuses to ship.
    expect(fields(valid({ activation: ['onCommand:'] }))).toEqual(['activation[0]']);
    expect(fields(valid({ activation: ['onView:'] }))).toEqual(['activation[0]']);
  });

  it('rejects a suffix that is only whitespace', () => {
    expect(fields(valid({ activation: ['onCommand:   '] }))).toEqual(['activation[0]']);
  });

  it('accepts an extension with no activation events at all', () => {
    // Nothing activates it, which is odd but not malformed — a manifest that only
    // contributes static declarations is legal.
    expect(parseManifest(valid({ activation: [] }), 'user').ok).toBe(true);
  });
});

describe('contributed commands', () => {
  it('rejects an empty id', () => {
    expect(fields(valid({ contributes: { commands: [{ id: '', title: 'X' }] } }))).toEqual([
      'contributes.commands[0].id',
    ]);
  });

  it('rejects a duplicate id within the manifest, naming it', () => {
    // The registry throws on a duplicate at register time; catching it here means
    // the second copy is reported as a manifest defect rather than as a mid-
    // activation crash that leaves half the extension registered.
    const message = text(
      valid({
        contributes: {
          commands: [
            { id: 'tasks.create', title: 'A' },
            { id: 'tasks.create', title: 'B' },
          ],
        },
      }),
    );
    expect(message).toContain('tasks.create');
    expect(message).toContain('duplicate');
  });

  it('points the duplicate at the SECOND occurrence', () => {
    expect(
      fields(
        valid({
          contributes: {
            commands: [
              { id: 'a.b', title: 'A' },
              { id: 'a.b', title: 'B' },
            ],
          },
        }),
      ),
    ).toEqual(['contributes.commands[1].id']);
  });

  it('accepts distinct ids', () => {
    expect(
      parseManifest(
        valid({
          contributes: {
            commands: [
              { id: 'tasks.create', title: 'A' },
              { id: 'tasks.close', title: 'B' },
            ],
          },
        }),
        'user',
      ).ok,
    ).toBe(true);
  });
});

describe('dependencies', () => {
  it('must look like ids', () => {
    expect(fields(valid({ dependencies: ['worktrees'] }))).toEqual(['dependencies[0]']);
  });

  it('may not include the extension itself', () => {
    // `extensions.get` resolving your own id is either a no-op or a re-entrant
    // activation; declaring it is a mistake with no useful reading.
    const message = text(valid({ dependencies: ['shepherd.tasks'] }));
    expect(message).toContain('itself');
    expect(fields(valid({ dependencies: ['shepherd.tasks'] }))).toEqual(['dependencies[0]']);
  });

  it('accepts a real dependency arrow from the spec §3 table', () => {
    expect(parseManifest(valid({ id: 'shepherd.claude-code', dependencies: ['shepherd.agents-core'] }), 'user').ok).toBe(
      true,
    );
  });
});

describe('every error, not the first', () => {
  it('accumulates across independent fields', () => {
    // Same rule the Schema validator follows: a manifest with four defects should
    // take one fix cycle, not four.
    expect(
      fields({
        id: 'tasks',
        name: 'Tasks',
        version: 'one',
        api: '*',
        activation: ['onLaunch'],
        permissions: ['filesystem'],
        dependencies: ['nope'],
      }),
    ).toEqual(['id', 'version', 'api', 'activation[0]', 'permissions[0]', 'dependencies[0]']);
  });
});

describe('the shape helpers', () => {
  it('isExtensionIdShape', () => {
    expect(isExtensionIdShape('shepherd.tasks')).toBe(true);
    expect(isExtensionIdShape('tasks')).toBe(false);
    expect(isExtensionIdShape('shepherd tasks')).toBe(false);
  });

  it('isVersion is exact and isVersionRange allows one operator', () => {
    expect(isVersion('1.0.0')).toBe(true);
    expect(isVersion('^1.0.0')).toBe(false);
    expect(isVersionRange('^1.0.0')).toBe(true);
    expect(isVersionRange('1.0.0')).toBe(true);
    expect(isVersionRange('^^1.0.0')).toBe(false);
  });
});
