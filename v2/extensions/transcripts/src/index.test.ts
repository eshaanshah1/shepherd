import { describe, expect, it } from 'vitest';
import { searchWith } from './index.ts';
import { createIndex, type IndexFs } from './store.ts';

const ROOT = '/Users/me/.shepherd/v2/tasks/fix-login';
const FOLDER = '-Users-me--shepherd-v2-tasks-fix-login';

const rec = (text: string): string =>
  `${JSON.stringify({
    type: 'user',
    cwd: ROOT,
    timestamp: '2026-08-13T10:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`;

function fakeFs(files: Record<string, string>): IndexFs {
  return {
    listDirs: () => [FOLDER],
    listFiles: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    stat: (path) =>
      files[path] === undefined ? null : { size: files[path].length, mtimeMs: 1 },
    readRange: (path, from) => (files[path] ?? '').slice(from),
    readText: () => undefined,
    writeText: () => undefined,
  };
}

const indexWith = (files: Record<string, string>) =>
  createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs: fakeFs(files) });

describe('searchWith', () => {
  it('returns a hit carrying the dir, the session id and the highlight range', async () => {
    const index = indexWith({
      [`/projects/${FOLDER}/aaa.jsonl`]: rec('i wanna add recall to shepherd'),
    });

    const hits = await searchWith(index, { query: 'recall', dirs: [ROOT] });

    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.dir).toBe(ROOT);
    expect(hit?.sessionId).toBe('aaa');
    expect(hit?.when).toBe(Date.parse('2026-08-13T10:00:00.000Z'));
    const match = hit?.matches[0];
    expect(match?.text.slice(match.at[0], match.at[1])).toBe('recall');
  });

  it('reports the uncapped total beside the capped matches', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall').repeat(5) });

    const hits = await searchWith(index, { query: 'recall', dirs: [ROOT], maxPerSession: 2 });

    expect(hits[0]?.matches).toHaveLength(2);
    expect(hits[0]?.total).toBe(5);
  });

  it('omits a session that matched nothing', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('nothing relevant') });
    expect(await searchWith(index, { query: 'recall', dirs: [ROOT] })).toEqual([]);
  });

  it('answers an empty query with no hits rather than everything', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });
    expect(await searchWith(index, { query: '  ', dirs: [ROOT] })).toEqual([]);
  });

  it('answers no dirs with no hits', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });
    expect(await searchWith(index, { query: 'recall', dirs: [] })).toEqual([]);
  });

  it('attributes the hit to the longest matching requested dir', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });

    const hits = await searchWith(index, { query: 'recall', dirs: ['/Users/me', ROOT] });

    expect(hits[0]?.dir).toBe(ROOT);
  });

  it('resolves empty when the signal is already aborted', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });
    const controller = new AbortController();
    controller.abort();

    expect(
      await searchWith(index, { query: 'recall', dirs: [ROOT], signal: controller.signal }),
    ).toEqual([]);
  });

  it('omits the title when a session has none, rather than sending undefined', async () => {
    const index = indexWith({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('recall') });

    const hits = await searchWith(index, { query: 'recall', dirs: [ROOT] });

    expect(Object.hasOwn(hits[0] ?? {}, 'title')).toBe(false);
  });
});
