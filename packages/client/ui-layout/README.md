---
description: "Shell layout for the Web GUI: the three-column AppFrame with drag handles, concession behavior, the panel-geometry service, and theme presentation; for users and maintainers of the window chrome."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

## Summary

This package provides a three-column Web frame with resizable sidebar and details panels. Plugins can add Session-scoped work views beside the native Tool details without replacing conversation. Wide windows reserve a details column; narrow windows switch between conversation and details, yielding to pending interactions. The package also presents the theme. Geometry and view selection are transient and reset on reload.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin at the root slot; it renders the frame around the sidebar, conversation, and details occupants. Users resize the sidebar by its hit strip and details by its floating pill. A closed sidebar retains a 56px control rail. When details cannot fit beside conversation, the frame shows a full-width details view with a return control; Escape returns without remounting conversation or replacing its draft.

### Add a work view

Contribute a fresh id and localized label to `shell.details.view` through `ctx.slots.inject` and `ctx.slots.register`. Inject `detailViews` and project its actions into component props: `open(sessionId, id)` selects and focuses a registered view; `close(sessionId)` returns to conversation. Both reject a non-current Session with `false`, and open rejects a removed id. Invoke them after the root mounts; premature calls throw. Repeated open focuses again, and retained handles return `false` after layout teardown. The native `ctx.layout.openDetails()` selects native Tool details, never a plugin view.

The frame owns navigation, not business objects, authorization, requests, or editing state. A view receives standard Session props and keeps its own data access. Closing or switching unmounts the plugin view. Removing the selected registration returns to native details; reinstalling it does not steal another view's selection. In compact layout a pending interaction returns to native conversation without answering or dismissing it.

### Theme presentation

The presenter consumes resolved theme snapshots and projects them onto the document: `html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens and `--dsh-content-font-size` as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background. Disposing the presenter removes its metadata node with its other global writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `register()` call contributes `AppFrame` into `'root'`, declares five children (`sidebar`, `conversation`, `details`, `shell.details.view`, `shell.overlay`), and seats the layout store. `ctx.layout` and `ctx.detailViews` mutate that store; the Slot registry remains the registration authority. A stable observable projects live view labels, including locale changes. Conversation retains its tree position while strict views render through `SessionProvider`. The selected Session title composes with the product title or localized fallback. A separate theme effect applies palette, font-size, and tokens before measuring the rendered background. No layout state reads or writes `localStorage`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the layout surface is not enough. They move from the frame to the columns it renders and the theme it presents.

- [ui-sidebar](../ui-sidebar/README.md) — occupies the `sidebar` column and its seats.
- [ui-conversation](../ui-conversation/README.md) — occupies the `conversation` column and owns native input.
- [ui-chat](../ui-chat/README.md) — owns native `details` and the Tool-details child.
- [ui-theme](../ui-theme/README.md) — the theme seam whose resolved snapshots the presenter consumes.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current layout behavior. They are current package constraints, not a general window-manager comparison or a task backlog.

- **Selection is transient** — reload and Session changes, including blank or unselected states, close details and forget the selected view and dragged width.
- **One auxiliary view at a time** — no docking manager, object tabs, canvas, timeline, or persisted open-object list. Plugins own any domain-specific navigation inside their view.
- **Native closed-details structure** — native details stays mounted at zero width, including its accessibility projection. Plugin views and their switch controls unmount on close; this extension does not include a full native accessibility audit.
- **Stored width is not rendered width** — the concession solver may narrow it; compact mode fills the frame. A pending interaction closes compact details rather than automatically reopening it later.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The shell viewing-state store behind ctx.layout emits no cordis events; clamp/prune/concession-chain sequencing is asserted directly by this package's columns and service specs.
