// The half of D11 that R1 finished (ADR 0035 §3).
//
// The resume TARGET was always opaque here; the binary and the flag around it
// were not — `planResume` built `claude --resume` in this package, with a
// comment saying it should not. That is gone, and this is the guard that keeps
// it gone: a grep, because the thing being asserted is the absence of a string
// and no unit test of behaviour can see that.
//
// Deliberately narrow. `provision.ts` still writes `CLAUDE.md` and reads
// `.claude/`, and `launch.ts` still names the binary for a LAUNCH — both are
// real vendor couplings, both predate this, and both are bigger than a resume
// line (a launch carries a prompt file and a shell built around it, which is a
// larger shape than a kind declares today). Asserting them here would either
// fail on day one or have to be weakened into something that guards nothing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** Comments explain the seam; only CODE may not spell it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the vendor boundary', () => {
  it('builds no resume command of its own', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => code(readFileSync(file, 'utf8')).includes('--resume'))
      .map((file) => file.slice(SRC.length));

    expect(
      offenders,
      'a resume line is the agent kind’s to build; ask agents.resumeCommand',
    ).toEqual([]);
  });

  it('asks the agent layer by its generic verb, never a vendor by name', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => code(readFileSync(file, 'utf8')).includes('claudeCode.'))
      .map((file) => file.slice(SRC.length));

    expect(offenders).toEqual([]);
  });
});
