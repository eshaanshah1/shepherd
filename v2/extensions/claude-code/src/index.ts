import { s, type ActivateFn, type ExtensionContext, type Shepherd } from '@shepherd/sdk';
import type { AgentsAPI } from '@shepherd/ext-agents-core';
import { claudeKind, CLAUDE_KIND_ID, type ClaudeSlot } from './kind.ts';
import { AGENTS_CORE_ID, CLAUDE_COMMANDS } from './manifest.ts';

/**
 * `shepherd.claude-code` — Claude Code as one agent kind.
 *
 * Deliberately small. Everything about *what a state means* is in `agents-core`;
 * everything about *what Claude says* is in `kind.ts`; this file is the wiring
 * between them, and its size is the evidence that the seam is real — a vendor
 * adapter that needed more than this would mean `agents-core` is not
 * vendor-blind after all.
 */

export { claudeKind, reduce, CLAUDE_HOOK_TOPIC, CLAUDE_KIND_ID } from './kind.ts';
export type { ClaudeSlot } from './kind.ts';
export * from './stop-policy.ts';

export const activate: ActivateFn = (ctx: ExtensionContext, api: Shepherd) => {
  const { commands, extensions } = api.proposed;

  // Declared in the manifest's `dependencies`, so the registry has already
  // activated it and this resolves. An undeclared id would be a typed refusal,
  // not an undefined — reaching another extension is declared, not discovered.
  const agents = extensions.get<AgentsAPI>(AGENTS_CORE_ID);
  if (agents === undefined) {
    // Refusing loudly rather than registering nothing: an adapter whose host is
    // absent is exactly the "believes it contributed, nobody saw it" failure,
    // and a thrown activation is recorded on the extension's registry record
    // with this reason attached.
    throw new Error(
      `${AGENTS_CORE_ID} is declared as a dependency but exported no API — claude-code has nothing to register into`,
    );
  }

  ctx.subscriptions.push(agents.registerKind(claudeKind()));

  ctx.subscriptions.push(
    commands.register(CLAUDE_COMMANDS.resumeTarget, {
      title: 'Claude Code: Show Resume Target',
      schema: s.object({ sessionId: s.string() }),
      /**
       * What `claude --resume` would reattach to for this session.
       *
       * Read out of the kind's own slot rather than a map of this extension's —
       * the slot dies with the session, a map would not. **Capture only in M2**:
       * nothing persists it across a restart yet, because layout persistence is
       * deliberately unwired and there is therefore nothing to restore into.
       * The consumer lands with that, in M3.
       */
      handler: (args) => {
        const slot = agents.slotOf(args.sessionId) as ClaudeSlot | undefined;
        return {
          sessionId: args.sessionId,
          kind: CLAUDE_KIND_ID,
          resumeSessionID: slot?.resumeSessionID ?? null,
          // The lock is a different fact from the target, and showing both is
          // how "why did my nested claude get ignored" is answerable at all.
          ownerClaudeSessionID: slot?.ownerClaudeSessionID ?? null,
        };
      },
    }),
  );

  ctx.log.info(`registered the ${CLAUDE_KIND_ID} kind with ${AGENTS_CORE_ID}`);
};
