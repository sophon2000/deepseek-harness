/** Session-addressed navigation for plugin-owned views in the native details column. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PanelActions } from './service.ts'

/** Public navigation actions; registrations belong to the shell.details.view Slot. */
export interface DetailViews {
  /**
   * Select and focus a registered view in the currently visible Session.
   * @param sessionId - Session of the initiating gesture; stale/background Sessions are rejected.
   * @param viewId - Plugin-owned shell.details.view registration id.
   * @returns false if the Session or registration is no longer current; no navigation occurs.
   */
  open(sessionId: SessionId, viewId: string): boolean
  /**
   * Return to the native conversation without changing its draft or history.
   * @param sessionId - Session of the initiating gesture.
   * @returns false for a stale/background Session; no navigation occurs.
   */
  close(sessionId: SessionId): boolean
}

/** Navigation controller; all viewing state is held in the root entry's declared store. */
export class DetailViewController implements DetailViews {
  #actions: PanelActions | undefined
  #disposed = false

  constructor(
    private readonly currentSession: () => SessionId | undefined,
    private readonly registered: (id: string) => boolean,
  ) {}

  /**
   * Connect the rendered root's store actions.
   * @param actions - Framework-bound actions, replaced when the root remounts.
   */
  attach(actions: PanelActions): void { if (!this.#disposed) this.#actions = actions }

  /** Revoke retained navigation handles when the owning plugin unloads. */
  dispose(): void { this.#disposed = true; this.#actions = undefined }

  open(sessionId: SessionId, viewId: string): boolean {
    if (this.#disposed || this.currentSession() !== sessionId || !this.registered(viewId)) return false
    this.#require().openView(sessionId, viewId)
    return true
  }

  close(sessionId: SessionId): boolean {
    if (this.#disposed || this.currentSession() !== sessionId) return false
    this.#require().closeDetails()
    return true
  }

  #require(): PanelActions {
    if (this.#actions === undefined) throw new Error('detailViews: root entry not mounted')
    return this.#actions
  }
}

/** Label projection of one live Slot registration. */
export interface DetailViewTab { readonly id: string; readonly label: string }
