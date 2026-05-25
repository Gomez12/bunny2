# Whiteboards

Whiteboards are infinite canvases for sketching ideas, diagrams,
flowcharts, and mood boards inside a layer. bunny2 embeds the
[Excalidraw](https://excalidraw.com) drawing canvas — the same
hand-drawn look-and-feel — and adds layer-scoped storage,
versioning, and the usual bunny2 share-via-layer model.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/entities.md` §10k and ADRs
> `0028` / `0029` / `0030`.

---

## 1. What a whiteboard is

A whiteboard belongs to **one layer**. Anyone who can see the layer
can open the whiteboard; anyone who can edit the layer can change
it. There is no separate per-whiteboard sharing — the layer is the
share unit, exactly like companies, contacts, calendar events, and
todos.

The drawing surface holds rectangles, arrows, text, freehand
strokes, sticky-note groups, and pasted images. The full Excalidraw
feature set is available except the items listed under "Known
limits" below.

---

## 2. Creating a whiteboard

1. Switch to the layer where the whiteboard should live (use the
   layer switcher in the app header).
2. Click **Whiteboards** in the layer navigation. The path is
   `/l/<your-layer-slug>/whiteboards`.
3. Click **New whiteboard**. Give it a title; the editor opens
   immediately on a blank canvas.

The new whiteboard shows up in the list view for everyone who can
see the layer.

---

## 3. Editing — debounced auto-save

As soon as you start drawing, bunny2 saves your changes to the
server in the background. The save is **debounced** — short bursts
of edits collapse into one save call, so you can drag, stretch, and
re-colour shapes freely without flooding the network.

You do not need a "Save" button for normal edits. The bottom
status indicator shows when a save is in flight ("Saving…") and
when the last save completed ("Saved a moment ago").

If your network drops, your edits queue locally and resume the
next time the connection comes back. If two people open the same
whiteboard at the same time, the editor shows a **lock banner** —
only one editor at a time in v1 (see "Known limits").

---

## 4. Save version — checkpoints

Auto-save keeps your latest work safe, but it does not snapshot
the canvas at meaningful moments. Use the **Save version** button
in the editor toolbar to create a **checkpoint** — a named
snapshot you can come back to later.

Checkpoints are also created automatically about 2 minutes after
your most recent edit (so a tab you forget to close still leaves a
recoverable snapshot). Earlier versions appear in the whiteboard's
version history panel; selecting one shows that snapshot read-only
so you can copy from it.

---

## 5. Exporting — PNG and SVG

From the editor toolbar:

- **Export as PNG** — bitmap export, good for slide decks and
  chat attachments.
- **Export as SVG** — vector export, good for diagrams you may
  want to scale or edit elsewhere.

The export uses the upstream Excalidraw renderer and matches what
you see in the browser. Both export formats include only the
elements visible on the canvas (not the version history, not the
file index).

---

## 6. Sharing — the layer is the share unit

To share a whiteboard with someone else, **invite them to the
layer** the whiteboard lives in. Once they are a member of the
layer they see the whiteboard in the list, can open it, and (if
they have edit rights on the layer) can change it.

There is no per-whiteboard share link, no per-whiteboard ACL, and
no public read mode in v1. If you need to share with a wider
audience, create a dedicated layer for that audience and move the
whiteboard there. This matches how all other bunny2 entity kinds
behave — see `docs/user/guides/working-with-layers.md`.

---

## 7. Known limits

A short list of behaviours that are intentionally **not** in v1:

- **No live collaboration.** Only one person at a time can edit a
  whiteboard. If a second user opens it, they see a lock banner
  and a read-only view until the first user closes the editor.
  Real-time multi-cursor editing is on the roadmap but not in v1.
- **Per-file size cap of 2 MiB.** Images and library shapes
  pasted into the canvas are stored inside the whiteboard. Each
  file is capped at 2 MiB after encoding. A larger upload fails
  with a "file too large" message; trim or compress the image
  first.
- **No public share links.** The layer is the share unit (see §6).
- **No per-element diff in the version history.** A checkpoint
  shows the whole canvas at that moment; bunny2 does not yet
  highlight which shapes moved between two versions.
- **No Excalidraw library import in v1.** The library shapes shipped
  with Excalidraw work; importing third-party `.excalidrawlib`
  files is disabled in this version.

---

## 8. Related reading

- `docs/user/guides/getting-started.md` — first steps with bunny2.
- `docs/user/guides/working-with-layers.md` — how layers control
  who sees what.
- `docs/user/guides/working-with-chat.md` — the layer chat, which
  can answer questions that reference whiteboards in the same
  layer.
