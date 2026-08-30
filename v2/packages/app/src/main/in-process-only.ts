import type { Caller } from '@shepherd/sdk';

/**
 * The guard on a verb that runs a command **as somebody else**.
 *
 * Three of the chrome's verbs do that: `views.activate` and `views.invoke` run a
 * command as the extension that contributed the view (ADR 0031's D14, ADR 0033),
 * and `settings.invoke` runs one as the extension that contributed the page. The
 * attribution is right — the click is the user's, the command id is the
 * extension's, and the user cannot see it — but it means the verb is a way to
 * *become* an extension, and the command id is supplied by the caller.
 *
 * While they were `ipcMain` channels that was contained: only the renderer could
 * reach them. Stage 2 of the core/UI isolation put them in the one verb table so
 * the app stops having a private door, and the containment has to be restated
 * rather than dropped — otherwise any principal holding `views` could run any
 * command as any extension, which is precisely the hole D14 closed.
 *
 * So: an in-process caller only, for now. That is honest rather than
 * satisfactory, and it is a deliberate residue named in the Stage 2 handoff. The
 * real fix is for the kernel to remember what a view OFFERED — every
 * `views.children` answer names its rows' commands, so activating one the view
 * never offered could be refused, and the verb could then be public. Nothing
 * needs it until a second client draws a contributed tree, which is Stage 4.
 *
 * Note what this is NOT: a claim that the app is special. `user` is minted
 * in-process by the code that saw the keystroke, and `externalCallerSchema`
 * already refuses it from any socket. This says the same thing one layer up.
 */
export function refuseExternalCaller(caller: Caller, verb: string): void {
  if (caller.kind === 'user' || caller.kind === 'kernel') return;
  throw new Error(
    `"${verb}" runs a command as another principal, so only an in-process caller may invoke it. ` +
      'A client that wants the row\'s effect invokes the command itself, under its own identity.',
  );
}
