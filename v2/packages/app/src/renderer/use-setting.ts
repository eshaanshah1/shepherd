import { useEffect, useState } from 'react';
import type { SettingsApi } from '../shared/index.ts';

/**
 * One `shepherd.*` setting, followed.
 *
 * The shell reads a setting through exactly the interface an extension reads its
 * own keys through (`settings.list` + the change push), which is the point of
 * `settings-general.ts` contributing the app's page the same way an extension
 * contributes one: a bug on that path is a bug in the app's own General page and
 * cannot hide in a corner only third parties visit.
 *
 * It answers a STRING because the only caller is the theme and the only thing a
 * caller can safely do with a value that crossed a port is treat it as text until
 * it has been checked — `resolveThemeMode` is that check, and an unreadable value
 * lands on the same branch a `system` does.
 */
export function useSetting(settings: SettingsApi | null, key: string, fallback = ''): string {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    if (settings === null) return;
    let live = true;
    const read = async (): Promise<void> => {
      const listed = await settings.list();
      if (!live || !listed.ok) return;
      const found = listed.value.values[key];
      setValue(typeof found === 'string' ? found : fallback);
    };
    void read();
    /**
     * Re-read on ANY change rather than only on this key's.
     *
     * A settings snapshot is one round trip and a change is rare; filtering here
     * would save nothing and would be a second place that has to agree about
     * which key matters. The push exists so nobody has to guess when to re-read.
     */
    const off = settings.onChanged(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [settings, key, fallback]);

  return value;
}
