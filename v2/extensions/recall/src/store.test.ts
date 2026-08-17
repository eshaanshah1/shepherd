import { describe, expect, it } from 'vitest';
import { createIndex, type IndexFs } from './store.ts';

const ROOT = '/Users/me/.shepherd/v2/tasks/fix-login';
const FOLDER = '-Users-me--shepherd-v2-tasks-fix-login';

const rec = (text: string, cwd = ROOT): string =>
  `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } })}\n`;

interface FakeFs extends IndexFs {
  files: Record<string, string>;
  reads: string[];
}

/** An in-memory disk. `mtimeMs` tracks content length, so a write always looks new. */
function fakeFs(files: Record<string, string>): FakeFs {
  const reads: string[] = [];
  return {
    files,
    reads,
    listDirs: (dir) => {
      const found = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(`${dir}/`)) continue;
        const rest = path.slice(dir.length + 1);
        const head = rest.split('/')[0];
        if (head !== undefined && rest.includes('/')) found.add(head);
      }
      return [...found];
    },
    listFiles: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.jsonl'))
        .map((p) => p.slice(dir.length + 1))
        .filter((name) => !name.includes('/')),
    stat: (path) => {
      const content = files[path];
      if (content === undefined) return null;
      return { size: Buffer.byteLength(content), mtimeMs: content.length };
    },
    readRange: (path, from) => {
      reads.push(`${path}@${String(from)}`);
      return (files[path] ?? '').slice(from);
    },
    readText: (path) => files[path],
    writeText: (path, text) => {
      files[path] = text;
    },
  };
}

const indexOn = (fs: IndexFs) =>
  createIndex({ projectsDir: '/projects', cacheFile: '/cache.json', fs });

describe('createIndex', () => {
  it('digests a session in a matching folder', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('i wanna add recall') });
    const index = indexOn(fs);

    await index.refresh([ROOT]);
    const sessions = index.sessionsIn([ROOT]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.digest.sessionId).toBe('aaa');
    expect(sessions[0]?.digest.turns[0]?.text).toBe('i wanna add recall');
  });

  it('never opens a folder belonging to another task', async () => {
    const fs = fakeFs({
      '/projects/-Users-me-dev-other/bbb.jsonl': rec('unrelated', '/Users/me/dev/other'),
    });
    const index = indexOn(fs);

    await index.refresh([ROOT]);

    expect(fs.reads).toEqual([]);
    expect(index.sessionsIn([ROOT])).toEqual([]);
  });

  it('re-reads only the bytes a grown file gained', async () => {
    const first = rec('one');
    const path = `/projects/${FOLDER}/aaa.jsonl`;
    const fs = fakeFs({ [path]: first });
    const index = indexOn(fs);

    await index.refresh([ROOT]);
    expect(fs.reads).toEqual([`${path}@0`]);

    fs.files[path] = first + rec('two');
    await index.refresh([ROOT]);

    expect(fs.reads).toEqual([`${path}@0`, `${path}@${String(Buffer.byteLength(first))}`]);
    expect(index.sessionsIn([ROOT])[0]?.digest.turns.map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('does not re-read an unchanged file at all', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    const index = indexOn(fs);

    await index.refresh([ROOT]);
    await index.refresh([ROOT]);

    expect(fs.reads).toHaveLength(1);
  });

  it('re-parses from scratch when a file SHRANK', async () => {
    const path = `/projects/${FOLDER}/aaa.jsonl`;
    const fs = fakeFs({ [path]: rec('one') + rec('two') });
    const index = indexOn(fs);
    await index.refresh([ROOT]);

    fs.files[path] = rec('replaced');
    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])[0]?.digest.turns.map((t) => t.text)).toEqual(['replaced']);
  });

  it('excludes a session whose recorded cwd is outside the dirs', async () => {
    // The folder name matched by prefix; the cwd is the authority and rejects it.
    const fs = fakeFs({ [`/projects/${FOLDER}-2/ccc.jsonl`]: rec('elsewhere', `${ROOT}-2`) });
    const index = indexOn(fs);

    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])).toEqual([]);
  });

  it('drops a session with no turns, titles or recap', async () => {
    const fs = fakeFs({
      [`/projects/${FOLDER}/aaa.jsonl`]: `${JSON.stringify({ type: 'summary' })}\n`,
    });
    const index = indexOn(fs);

    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])).toEqual([]);
  });

  it('stops early when the signal aborts', async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 20; n++) {
      files[`/projects/${FOLDER}/s${String(n)}.jsonl`] = rec(`turn ${String(n)}`);
    }
    const fs = fakeFs(files);
    const index = indexOn(fs);

    const controller = new AbortController();
    controller.abort();
    await index.refresh([ROOT], controller.signal);

    expect(fs.reads).toEqual([]);
  });

  it('orders sessions newest first', async () => {
    const stamped = (id: string, ts: string): string =>
      `${JSON.stringify({ type: 'user', cwd: ROOT, timestamp: ts, message: { role: 'user', content: id } })}\n`;
    const fs = fakeFs({
      [`/projects/${FOLDER}/old.jsonl`]: stamped('old', '2026-08-01T00:00:00.000Z'),
      [`/projects/${FOLDER}/new.jsonl`]: stamped('new', '2026-08-13T00:00:00.000Z'),
    });
    const index = indexOn(fs);

    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT]).map((s) => s.digest.sessionId)).toEqual(['new', 'old']);
  });

  it('round-trips through the cache file so a restart is not a cold parse', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    const first = indexOn(fs);
    await first.refresh([ROOT]);
    first.save();

    const reads = fs.reads.length;
    const second = indexOn(fs);
    await second.refresh([ROOT]);

    expect(fs.reads).toHaveLength(reads);
    expect(second.sessionsIn([ROOT])[0]?.digest.turns[0]?.text).toBe('one');
  });

  it('ignores a cache file written by another version', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    fs.files['/cache.json'] = JSON.stringify({ version: 0, entries: {} });
    const index = indexOn(fs);

    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])).toHaveLength(1);
  });

  it('survives an unreadable cache file', async () => {
    const fs = fakeFs({ [`/projects/${FOLDER}/aaa.jsonl`]: rec('one') });
    fs.files['/cache.json'] = 'not json';
    const index = indexOn(fs);

    await expect(index.refresh([ROOT])).resolves.toBeUndefined();
    expect(index.sessionsIn([ROOT])).toHaveLength(1);
  });

  it('does not consume a trailing partial line, so it is re-read when completed', async () => {
    const path = `/projects/${FOLDER}/aaa.jsonl`;
    const partial = '{"type":"user","cwd":"/Users/me/.shepherd/v2/tasks/fix-login","message":{"rol';
    const fs = fakeFs({ [path]: rec('one') + partial });
    const index = indexOn(fs);
    await index.refresh([ROOT]);

    // The rest of that record arrives.
    fs.files[path] = rec('one') + rec('two');
    await index.refresh([ROOT]);

    expect(index.sessionsIn([ROOT])[0]?.digest.turns.map((t) => t.text)).toEqual(['one', 'two']);
  });
});
