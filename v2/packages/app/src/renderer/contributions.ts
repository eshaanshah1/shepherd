import { useEffect, useState } from 'react';
import type { ViewContributionDTO, ViewsApi } from '../shared/index.ts';

/**
 * Which views exist, followed rather than fetched once.
 *
 * One hook because two parts of the shell need the same answer — the sidebar
 * draws the docked ones and the overlay layer binds the raisable ones — and two
 * subscriptions would be two chances to disagree about what is contributed.
 *
 * The list is re-read on every nudge, not just the rows: an extension activates
 * *after* the window loads, so the first answer predates every contribution.
 * That was measured in M3b — the dock registered, main logged it, and the screen
 * stayed empty.
 */
export function useContributions(bridge: ViewsApi | null): readonly ViewContributionDTO[] {
  const [views, setViews] = useState<readonly ViewContributionDTO[]>([]);

  useEffect(() => {
    if (bridge === null) return;
    const read = async (): Promise<void> => {
      const listed = await bridge.list();
      if (listed.ok) setViews(listed.value);
    };
    void read();
    return bridge.onChanged(() => void read());
  }, [bridge]);

  return views;
}
