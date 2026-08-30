// The control plane's vocabulary, in the file both processes load.
//
// Every string here is a public name — a command id or a bus topic — and it is
// named ONCE for the same reason `SETTINGS_VISIBILITY_COMMAND` is: two spellings
// of a public name is two chances to disagree, and the disagreement is silent.
//
// It matters more than it used to. The preload is what turns `views.onChanged`
// into a subscription and `settings.set` into an invoke, so these constants are
// the whole of what keeps a compromised page from naming its own topic: the page
// asks for a named CAPABILITY, and the preload decides which topic that is.

/** The topics the chrome follows. A page never sees one of these strings. */
export const CONTROL_TOPICS = {
  /**
   * Agent state per session, as the indicator draws it.
   *
   * Stateful: subscribing hands over the current set before any change, which is
   * what let `agents.get()` go. The page used to follow-then-pull and merge the
   * snapshot UNDER whatever had already arrived, because a transition landing
   * between the two calls would otherwise be overwritten by a snapshot taken
   * before it. That is the exact race snapshot-then-delta removes.
   */
  agents: 'agents.indicators',
  /**
   * A contributed view changed — ADR 0031's nudge, now literally one.
   *
   * `nudge` delivery, so a chatty extension costs one frame per read rather than
   * one per change, and the frame names the view types that moved so the dock
   * re-reads those rather than all of them.
   */
  views: 'views.changed',
  /** One setting changed, whoever changed it: the screen, the CLI, an extension. */
  settingsChanged: 'settings.changed',
  /** Whether the settings screen is up. Stateful: main's word, current on subscribe. */
  settingsVisibility: 'settings.visibility',
} as const;

/** The verbs the chrome invokes by name. Each is a real command in the registry. */
export const CONTROL_COMMANDS = {
  viewsList: 'views.list',
  viewsChildren: 'views.children',
  viewsActivate: 'views.activate',
  viewsInvoke: 'views.invoke',
  viewsPresent: 'views.present',
  settingsList: 'settings.list',
  settingsSet: 'settings.set',
  settingsReset: 'settings.reset',
  settingsInvoke: 'settings.invoke',
} as const;
