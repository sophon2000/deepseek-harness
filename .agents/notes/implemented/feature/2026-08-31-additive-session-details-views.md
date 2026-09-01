# Agent Note: Additive Session details views

Status: implemented

English | [中文](2026-08-31-additive-session-details-views.zh.md)

## Problem

The native `details` slot has an owner. Replacing it to show a plugin workspace removes native Tool details; an overlay does not reserve conversation space. A Session-scoped plugin needs a place to show an object without owning the chat runtime or reaching into its private state.

## Decision

`ui-layout` declares the additive `shell.details.view` list and provides `ctx.detailViews`. Registrations use plugin-owned ids and localized labels. Navigation accepts the initiating Session id and rejects non-current or removed targets. The root store owns the selected view and focus revision; the Slot registry owns registration lifetime. The native `details` slot remains unchanged and `layout.openDetails()` selects it.

Desktop layout reserves the existing resizable column. When it cannot fit, details occupies the frame and conversation is hidden without unmounting. Escape and the return action restore reachable focus. A pending interaction yields compact details back to conversation without answering the interaction. Selection resets on Session change, including blank or unselected states, and on reload. Removing a selected view returns to native details; removing layout revokes retained navigation handles.

The Host has no new domain API, authorization, durable format, or model-facing Tool. Plugins retain responsibility for object identity, exact revisions, data access and cancellation. This fork source does not change the installed `vh.1` artifact; publication and consumer cold-install qualification remain separate release work.

## Alternatives considered

**Extend the native Tool-details owner.** Its content and selection belong to chat. Layout is the owner of width and visibility, so adding a generic view there avoids coupling business workspaces to Tool selection.

**Overlay or replace the root.** An overlay does not reserve space; replacing root duplicates native input, approval, and navigation responsibilities. Neither satisfies coexistence.

**Only use conversation tabs.** This is viable for a single full-page view but does not satisfy desktop conversation/workspace concurrency.

## Consequences

Only one auxiliary view is rendered at a time. There is no docking manager, persisted object-tab model, canvas or timeline. Switching away unmounts a plugin view; durable edits cannot live only in component state. A call before root mount throws, while stale Session, removed registration and disposed service handles return `false` without navigation. Layout reads pending-interaction state but does not take over its settlement.

## Verification

`ui-layout/tests` covers navigation guards, registry disposal/reinstallation, focus, compact layout, Session resets and pending interactions. `apps/web/tests/auxiliary-detail-views.e2e.ts` loads a test-only private profile through the actual Loader and browser artifact graph; it covers two independent plugin fibers, native draft preservation, compact geometry, reload and real native approval over a keyless recorded model replay. The existing GUI and Web lanes cover profiles without the test plugin. Installed consumer qualification must still run against a new immutable fork artifact family before default adoption.
