import { describe, expect, it } from 'vitest';
import { planLaunch, shellQuote } from './launch.ts';

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

  it('passes the picked model as --model, before the prompt argument', () => {
    const plan = planLaunch({ promptFile: '/tmp/p.txt', prompt: 'hi', model: 'fable' });
    expect(plan.command).toMatch(/; claude --model 'fable' "\$p"$/);
  });

  it('passes the model with no prompt too', () => {
    const plan = planLaunch({ promptFile: '/tmp/p.txt', prompt: '', model: 'haiku' });
    expect(plan.command).toMatch(/; claude --model 'haiku'$/);
  });

  it('omits the flag entirely when no model was picked', () => {
    // Absent is the DEFAULT entry and every task created before models were
    // pickable. Passing `--model ''` would ask the vendor to resolve an empty
    // alias, which is a launch failure rather than a default.
    for (const model of [undefined, '', '   ']) {
      const plan = planLaunch({ promptFile: '/tmp/p.txt', prompt: 'hi', ...(model === undefined ? {} : { model }) });
      expect(plan.command).not.toContain('--model');
    }
  });

  it('quotes a model that is not one of the ids the picker offers', () => {
    // It crossed a command boundary as a string and lands in a shell line.
    const plan = planLaunch({ promptFile: '/tmp/p.txt', prompt: 'hi', model: "x'; rm -rf /" });
    expect(plan.command).toContain(`--model 'x'\\''; rm -rf /'`);
  });

  it('quotes a path containing a single quote instead of ending the argument', () => {
    // A repo called `it's` is not exotic, and unescaped it turns the rest of the
    // line into shell commands.
    expect(shellQuote("/tmp/it's/p.txt")).toBe(`'/tmp/it'\\''s/p.txt'`);
    const plan = planLaunch({ promptFile: "/tmp/it's/p.txt", prompt: 'hi' });
    expect(plan.command.startsWith(`p=$(cat '/tmp/it'\\''s/p.txt')`)).toBe(true);
  });
});
