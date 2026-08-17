import type { ReactElement } from 'react';
import type { ExtensionRowProps } from '@shepherd/sdk';
import { KeyCap, Row } from '@shepherd/ui';

/**
 * `12 in transcripts` — the row that admits what the rail cannot show.
 *
 * A transcript hit is four things (which task, which session, the line, when) and
 * needs two lines and about 500px. The rail is 264px with a 21px-padded field, so
 * a snippet indented under a session has ~31 characters against recall's 120: a
 * hit drawn here would truncate the exact string you searched for. So the rail
 * says how many exist and hands the query to a surface that can hold them.
 *
 * **It is a component rather than a plain row because only the renderer can raise
 * an overlay.** A `TreeItem.command` is invoked in the extension host, which has
 * no way to reach the modal layer; `sh:raise-view` is the event the shell already
 * listens for, and `empty-state.tsx` dispatches the same one for the composer.
 */

/** The view this raises. A literal, because `ui/` may not import the service half. */
const SESSION_SEARCH_VIEW = 'tasks.sessionSearch';

/**
 * The count, or null.
 *
 * `item.data` crossed an IPC port and arrives as `unknown`; a cast would be a
 * promise the wire does not keep. A zero or a malformed payload draws nothing
 * rather than `0 in transcripts`, which is a row offering to show you nothing.
 */
function totalOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const total = (data as { total?: unknown }).total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  return Math.floor(total);
}

export function TranscriptCountRow({ item }: ExtensionRowProps): ReactElement | null {
  const total = totalOf(item.data);
  if (total === null) return null;

  const open = (): void => {
    window.dispatchEvent(new CustomEvent('sh:raise-view', { detail: SESSION_SEARCH_VIEW }));
  };

  /*
   * `role`, `tabIndex` and the key handler are the CALLER's to supply — `Row` is
   * a `div` extending `ComponentPropsWithRef<'div'>` and says so on its props. A
   * row that is clickable and does not announce itself as a button is a row the
   * keyboard cannot reach.
   */
  return (
    <Row
      quiet
      gutter={false}
      role="button"
      tabIndex={0}
      meta={<KeyCap>⇧⌘F</KeyCap>}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}
    >
      {`${String(total)} in transcripts`}
    </Row>
  );
}
