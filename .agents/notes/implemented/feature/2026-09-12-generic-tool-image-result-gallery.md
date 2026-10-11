# Agent Note: Generic Tool Image Result Gallery

Status: implemented

English | [中文](2026-09-12-generic-tool-image-result-gallery.zh.md)

## Problem

The native image gallery was reachable only from the `read_image` keyed toolview. A third-party tool could return the same standard settled `[text, image]` content blocks, yet the Generic fallback displayed the attachment reference as JSON instead of a preview. Registering another keyed toolview could not reuse `tool.call.images`, because a child slot has one owning entry.

## Decision

`ToolCallTree` owns `tool.call.images` once beside `tool.call.toolview` and supplies each atomic view with a `renderImages` capability that closes over the Session-authorized loader. Built-in and third-party views do not import attachment UI or own authorization URLs.

The Generic fallback derives an image card for any successful result composed entirely of valid standard text and image blocks. It validates every attachment reference, renders the durable references through the existing gallery and lightbox, and keeps the text blocks as the readable envelope. Malformed references, errors, running calls, and results containing an unrendered extension block keep the existing flattened fallback.

The `read_image` keyed view retains its path-aware model and file-opening behavior, but consumes the same parent-provided image renderer and no longer owns a child slot.

## Alternatives considered

**Register one Video Harness-specific toolview.** This would solve one tool while repeating the same failure for every future image-bearing plugin and coupling a business plugin to DSH attachment presentation.

**Let each keyed toolview declare `tool.call.images`.** Slot ownership intentionally rejects duplicate child declarations, so this cannot compose independent plugins.

**Render base64 or URLs inside the Generic card.** This would duplicate authorization, loading, gallery, and lightbox behavior already owned by `ui-attachment`.

## Consequences

Standard image result blocks are now a portable presentation contract across tools. The Session log and model-visible content do not change, and deployments without `ui-attachment` still retain readable text. Generic image cards deliberately decline mixed extension-block results rather than silently hiding content.
