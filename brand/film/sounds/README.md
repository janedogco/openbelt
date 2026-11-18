# Intro clasp click

`clasp.s16le` is mono, 44,100 Hz, signed 16-bit little-endian PCM, embedded by
`bun run brand film` for synchronous playback in the live and offline scores.

Source: [small metal clasp (open, close, switching)](https://freesound.org/people/_sinny_/sounds/822397/)
by _sinny_, licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Commercial use and modification are permitted; attribution is optional.

Converted from the author's HQ MP3 preview, with stereo mixed to mono:

```sh
ffmpeg -i 822397_14007850-hq.mp3 -ac 1 -ar 44100 -f s16le clasp.s16le
```

The film plays it at 70% gain when the icon appears (0.08 seconds), replacing the
opening synthesized tick and bell. The pixel transition's score is unchanged.
