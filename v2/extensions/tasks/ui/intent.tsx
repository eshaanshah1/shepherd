import { useEffect, useState, type ReactElement } from 'react';
import type { ExtensionFaceProps } from '@shepherd/sdk';
import { TASK_COMMANDS } from '../src/manifest.ts';

/**
 * The **Intent** face of a task (ADR 0051): what you asked for, in your own
 * words.
 *
 * The one face whose subject its own extension already holds, and the reason it
 * is worth having at all: a task's brief is written once, at the composer, and
 * then never seen again — it lives in the record and appears nowhere on screen.
 * Three days into a task the question "what did I actually ask for" has no
 * surface to answer it, and the transcript is not that surface: it is what the
 * agent did, at length, and the ask is one paragraph.
 *
 * It draws the record and nothing derived. No summary, no restatement — the
 * value of this face is that it is the text you typed rather than somebody's
 * account of it.
 */
export function TaskIntentFace({ task, invoke }: ExtensionFaceProps): ReactElement {
  const [brief, setBrief] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [read, setRead] = useState(false);

  useEffect(() => {
    let live = true;
    void invoke(TASK_COMMANDS.list, {}).then((answer) => {
      if (!live) return;
      setRead(true);
      // `unknown` off a port, and a cast is not a check — even for our own
      // extension, because the answer crossed the same wire a third party's
      // would.
      if (!answer.ok || !Array.isArray(answer.value)) return;
      const found = answer.value.find(
        (each) => typeof each === 'object' && each !== null && (each as { id?: unknown }).id === task.id,
      ) as { brief?: unknown; title?: unknown } | undefined;
      if (typeof found?.brief === 'string') setBrief(found.brief);
      if (typeof found?.title === 'string') setTitle(found.title);
    });
    return () => {
      live = false;
    };
  }, [invoke, task.id]);

  if (brief === undefined || brief.trim() === '') {
    return (
      <div className="sh-face-note">
        {read ? 'This task was started without a brief.' : 'Reading the record…'}
      </div>
    );
  }

  return (
    <div className="sh-face-doc">
      <h3 className="sh-face-h">The ask</h3>
      {title === undefined ? null : <p className="sh-face-title">{title}</p>}
      {/*
        One paragraph per blank line, and no markdown renderer. A brief is
        prose typed into a composer, not a document — running it through a
        parser would turn a stray `#repo` mention into a heading, and the
        mention pills are the composer's own syntax rather than anybody's
        markup.
      */}
      {brief.split(/\n{2,}/).map((para, at) => (
        <p className="sh-face-p" key={`${at}-${para.slice(0, 12)}`}>
          {para}
        </p>
      ))}
    </div>
  );
}
