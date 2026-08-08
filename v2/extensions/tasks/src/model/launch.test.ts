import { describe, expect, it } from 'vitest';
import { planLaunch, shellQuote, planResume } from './launch.ts';

describe('planLaunch', () => {
  it('types ONE line, and the prompt is not on it', () => {
    const plan = planLaunch({ promptFile: '/tmp/p.txt', prompt: 'fix the bug\nand explain why' });
    expect(plan.command).not.toContain('\n');
    expect(plan.command).not.toContain('fix the bug');
  });

  it('consumes the prompt file whether or not the agent starts', () => {
    // The `rm` is unconditional and before the agent runs: a prompt left behind
    // in a data directory is somebody's brief sitting on disk forever.
    const plan = planLaunch({ promptFile: '/tmp/p.txt', prompt: 'hi' });
    expect(plan.command).toContain(`rm -f '/tmp/p.txt'`);
    expect(plan.command.indexOf('rm -f')).toBeLessThan(plan.command.indexOf('claude'));
  });

  it('runs the agent bare when there is no prompt', () => {
    expect(planLaunch({ promptFile: '/tmp/p.txt', prompt: '   ' }).command).toMatch(/; claude$/);
  });

  it('quotes a path containing a single quote instead of ending the argument', () => {
    // A repo called `it's` is not exotic, and unescaped it turns the rest of the
    // line into shell commands.
    expect(shellQuote("/tmp/it's/p.txt")).toBe(`'/tmp/it'\\''s/p.txt'`);
    const plan = planLaunch({ promptFile: "/tmp/it's/p.txt", prompt: 'hi' });
    expect(plan.command.startsWith(`p=$(cat '/tmp/it'\\''s/p.txt')`)).toBe(true);
  });
});

describe('planResume', () => {
  it('names the session and carries no prompt', () => {
    // The transcript IS the context. Typing the original brief at a resumed
    // session would restate what it already knows and read as a second
    // instruction — which is exactly what restoring a task used to do.
    expect(planResume('abc-123')).toBe("claude --resume 'abc-123'");
  });

  it('quotes the target, which came from somewhere else entirely', () => {
    // It is a vendor's token travelling opaquely (D11), so nothing here knows
    // what characters it can contain — and it lands on a shell line.
    expect(planResume("it's")).toBe(`claude --resume ${shellQuote("it's")}`);
  });
});
