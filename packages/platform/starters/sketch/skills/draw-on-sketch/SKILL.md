---
name: draw-on-sketch
description: "Draw something on the shared sketch canvas. Use when asked to draw, doodle, sign or leave a picture on the sketch board."
---

# Draw on the sketch

The canvas is 1000 x 750 units, (0, 0) at the top left. A drawing is a set of strokes; each stroke is one document in `strokes`:

```json
{
  "color": "#e0457b",
  "size": 5,
  "points": [
    [120, 300],
    [140, 290],
    [160, 285]
  ]
}
```

- Colours people use: `#1d1b18` ink, `#e0457b` pink, `#2f6fed` blue, `#1f9d6b` green, `#f2a516` yellow. Sizes: 5 thin, 14 thick.
- Put a point every 5-15 units along a curve so it draws smoothly; at most 1500 points a stroke.
- Add all the strokes of one drawing in a single `collection_add` call with `docs: [{ data }, ...]`, so it appears at once on every open page. Compute the points with code (circles, curves) rather than by hand.
- Keep clear of what is already there: read `strokes` first and draw in an empty area.
