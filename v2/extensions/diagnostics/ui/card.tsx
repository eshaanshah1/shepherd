import { useState } from 'react';
import type { ExtensionViewProps } from '@shepherd/sdk';

/**
 * The trivial consumer the **component** view kind was built against (ADR
 * 0033), deliberately not the composer.
 *
 * ADR 0031 built the tree kind against this same extension for the same reason:
 * a mechanism built against its real consumer gets shaped around one caller.
 * A static block of text would prove that a component mounts and nothing else,
 * so this carries the three axes a real one has — **local state** the host must
 * not clobber, an `invoke` whose **answer** is drawn (a tree row's click has no
 * answer, which is the whole reason `views.invoke` exists), and an `invoke`
 * that **fails**, because a failure arriving as a value rather than a thrown
 * mangled Electron string is the thing most likely to be wrong.
 *
 * It lives in `ui/`, not `src/`: `src/` is the service half and runs in a
 * utility process with no DOM. `boundaries.js` keeps react out of one and the
 * host out of the other.
 */
export function DiagnosticsCard({ invoke }: ExtensionViewProps): React.JSX.Element {
  const [answer, setAnswer] = useState<string>('not asked yet');

  const run = async (command: string, args?: unknown): Promise<void> => {
    const result = await invoke(command, args);
    setAnswer(result.ok ? JSON.stringify(result.value) : `${result.error.code}: ${result.error.message}`);
  };

  return (
    <div className="sh-ext-card" data-testid="diagnostics-card">
      <h2 className="sh-dock-title">diagnostics</h2>
      <button type="button" data-testid="diagnostics-ping" onClick={() => void run('diagnostics.bump')}>
        bump the tree
      </button>
      {/*
        A command this extension may not invoke. It comes back `denied` — as a
        VALUE, drawn below — which is the permission model reaching the page
        without anything in the page having to know what a permission is.
      */}
      <button
        type="button"
        data-testid="diagnostics-denied"
        onClick={() =>
          void run('attention.set', {
            target: 'diagnostics-card',
            level: 'attention',
            reason: 'the card is probing a capability its manifest never declared',
          })
        }
      >
        try something it may not do
      </button>
      <output className="sh-ext-answer" data-testid="diagnostics-answer">
        {answer}
      </output>
    </div>
  );
}
