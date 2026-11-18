---
name: edit-video
description: "Change someone's video project in Cut: add title cards or captions, retime, reorder or style clips. Use when asked to edit, caption or put text on a video in the cut app."
---

# Edit a video project

A project is one document in `projects`; each imported file is one document in `media` with the same `project` id. Both are
private: each person reads and changes only their own, so write as the person (MCP writes do). People import files in the page;
an agent changes the timeline.

Times are seconds. A clip shows from `start` to `start + duration` on the timeline and plays its file from `in`, at `speed`.
The canvas is `scene.width` × `scene.height` pixels, (0, 0) top left. `layers[0]` is drawn on top.

```json
{
  "id": "c_title1",
  "kind": "text",
  "layerId": "<a layer id from layers>",
  "start": 0,
  "duration": 3,
  "in": 0,
  "speed": 1,
  "name": "Title",
  "props": {
    "x": 960,
    "y": 540,
    "scale": 1,
    "rotation": 0,
    "opacity": 1,
    "volume": 1,
    "fit": "contain",
    "flipH": false,
    "flipV": false,
    "crop": { "l": 0, "t": 0, "r": 0, "b": 0 },
    "radius": 0,
    "shadow": 0,
    "blend": "source-over"
  },
  "kf": {},
  "fx": {},
  "preset": "none",
  "tin": { "type": "fade", "dur": 0.5 },
  "tout": { "type": "fade", "dur": 0.5 },
  "fadeIn": 0,
  "fadeOut": 0,
  "muted": false,
  "text": {
    "content": "Our launch",
    "font": "Montserrat",
    "size": 120,
    "weight": 800,
    "color": "#ffffff",
    "align": "center",
    "shadow": true
  }
}
```

- Read the project with `collection_list` (or `get`), change its `clips` (and `layers`) in your code, and write the whole
  document back with `collection_update` (`replace: true`) and the `ifSeq` you read, so you don't undo the person's edits.
- Clip ids are unique strings. Put text on a layer of its own at the front of `layers` (add `{ "id", "name" }` there).
- Captions: one text clip per phrase, 3 to 7 words, `y` at 0.8 × the height, `stroke: "#000000"`, `strokeWidth` about 0.09 ×
  the size, and `maxWidth` at 0.86 × the width so long lines wrap.
- Transitions (`tin`, `tout`): none, fade, slideLeft, slideRight, slideUp, slideDown, zoomIn, zoomOut, pop, rise, blur, spin,
  wipe, and typewriter for text. Keyframes animate x, y, scale, rotation, opacity and volume:
  `"kf": { "opacity": [{ "t": 0, "v": 0 }, { "t": 1, "v": 1 }] }`, with `t` from the clip's start.
- Media clips (`video`, `audio`, `image`) need a `mediaId` from the project's `media`; keep `in + duration × speed` within
  the file's `duration`.
