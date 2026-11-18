---
version: alpha
name: OpenBelt
description: OpenBelt's own look (marketing in www/, a workspace's home page). Mono on warm paper, Inter Tight headings, the slot mark. User apps don't follow it.
colors:
  primary: "#0c0b0a"
  on-primary: "#fffefb"
  neutral: "#fffefb"
  backdrop: "#fffefb"
  surface: "#f8f7f3"
  subtle: "#f1efe9"
  sidebar: "#f6f5f0"
  sidebar-selected: "#e8e5dc"
  border: "#e4e1d8"
  border-strong: "#d1cdc1"
  muted: "#6f6a5f"
  success: "#2f7a55"
  warning: "#8a5f00"
  error: "#b8352a"
  highlight: "#856000"
  art-blue: "#2f63b8"
  art-violet: "#6a4fc2"
  art-teal: "#1f7f78"
  art-coral: "#b5502f"
  primary-dark: "#f8f7f3"
  on-primary-dark: "#0c0b0a"
  neutral-dark: "#0c0b0a"
  backdrop-dark: "#000000"
  surface-dark: "#181714"
  subtle-dark: "#22201c"
  sidebar-dark: "#141311"
  sidebar-selected-dark: "#2a2824"
  border-dark: "#2b2925"
  border-strong-dark: "#403d36"
  muted-dark: "#a39e91"
  success-dark: "#67d29a"
  warning-dark: "#f2c14e"
  error-dark: "#ff7a6b"
  highlight-dark: "#ffd43b"
  art-blue-dark: "#7cb4ff"
  art-violet-dark: "#b49cff"
  art-teal-dark: "#5fd4c8"
  art-coral-dark: "#ff9f7a"
typography:
  hero:
    fontFamily: Inter Tight
    fontSize: 104px
    fontWeight: 650
    lineHeight: 1.12
    letterSpacing: -0.035em
  display:
    fontFamily: Inter Tight
    fontSize: 67px
    fontWeight: 650
    lineHeight: 1
    letterSpacing: -0.04em
  h1:
    fontFamily: Inter Tight
    fontSize: 43px
    fontWeight: 650
    lineHeight: 1.05
    letterSpacing: -0.03em
  h2:
    fontFamily: Inter Tight
    fontSize: 34px
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: -0.03em
  h3:
    fontFamily: Inter Tight
    fontSize: 27px
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: -0.025em
  h4:
    fontFamily: Inter Tight
    fontSize: 22px
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: -0.02em
  h5:
    fontFamily: Inter Tight
    fontSize: 18px
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: -0.015em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.55
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 550
    lineHeight: 1.2
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
logo:
  tileRadius: 0.22
  markRatio: 0.54
  faviconMarkRatio: 0.62
  appIcon:
    tile: ["#000000", "#000000"]
    mark: ["#ffffff", "#a6a6a6"]
rounded:
  sm: 6px
  md: 10px
  lg: 12px
  full: 9999px
spacing:
  2xs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
  4xl: 96px
  5xl: 128px
  control: 32px
components:
  page:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
  page-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.primary-dark}"
  marketing-page:
    backgroundColor: "{colors.backdrop}"
    textColor: "{colors.primary}"
  marketing-page-dark:
    backgroundColor: "{colors.backdrop-dark}"
    textColor: "{colors.primary-dark}"
  secondary-text:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.muted}"
  secondary-text-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.muted-dark}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
  panel-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.primary-dark}"
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.primary}"
  sidebar-dark:
    backgroundColor: "{colors.sidebar-dark}"
    textColor: "{colors.primary-dark}"
  sidebar-selected:
    backgroundColor: "{colors.sidebar-selected}"
    textColor: "{colors.primary}"
  sidebar-selected-dark:
    backgroundColor: "{colors.sidebar-selected-dark}"
    textColor: "{colors.primary-dark}"
  selected:
    backgroundColor: "{colors.subtle}"
    textColor: "{colors.primary}"
  selected-dark:
    backgroundColor: "{colors.subtle-dark}"
    textColor: "{colors.primary-dark}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "{spacing.control}"
    padding: 12px
  button-primary-dark:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-primary-dark}"
  button-secondary:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    height: "{spacing.control}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px
  outline:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  outline-dark:
    backgroundColor: "{colors.border-strong-dark}"
    height: 1px
  badge-success:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
  badge-warning:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.warning}"
    rounded: "{rounded.full}"
  badge-error:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.error}"
    rounded: "{rounded.full}"
  badge-success-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.success-dark}"
  badge-warning-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.warning-dark}"
  badge-error-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.error-dark}"
  squiggle:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.highlight}"
  squiggle-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.highlight-dark}"
  art-blue:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.art-blue}"
  art-blue-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.art-blue-dark}"
  art-violet:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.art-violet}"
  art-violet-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.art-violet-dark}"
  art-teal:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.art-teal}"
  art-teal-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.art-teal-dark}"
  art-coral:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.art-coral}"
  art-coral-dark:
    backgroundColor: "{colors.neutral-dark}"
    textColor: "{colors.art-coral-dark}"
motion:
  durationMs: 140
  easing: cubic-bezier(0.2, 0.8, 0.2, 1)
icons:
  set: lucide
  strokeWidth: 1.5
---

# OpenBelt

## Overview

OpenBelt is the open-source app store for you and your agents: small apps your agents build, on
your own machines, for you or your team. The
look is a tool you own, not a service you rent: quiet, precise, fast. Mono on warm paper, one
typeface family, square geometry, very little decoration. It leads dark (a workspace's home page follows
the system setting; marketing is dark).

The mark is the slot: a square on a 3x3 grid with the two left cells of the middle row removed
(after Yasaburo Kuwayama, Trademarks and Symbols Vol. 2, 1973, No. 1485). The icon is the tile: a
square with its corners rounded `logo.tileRadius` (0.22, so 22%) of its side, the slot cut out of it at 54%, centred (the slot itself
stays square). An app icon a platform rounds itself (iOS's apple-touch-icon) stays a full square. The lockup pairs the tile with "OpenBelt" in Geist 650 at -0.035em.
The tile is four-thirds the wordmark's cap height, with a gap one-quarter of the tile's side.
Centre the wordmark's capitals vertically against the tile; its descender hangs below.
The compact product size is a 16px tile with 12px capitals. Standalone sign-in and outcome
pages, and an agent's consent page, use a 32px tile with 24px capitals and 32px below the logo. An
app's consent page leads instead with what asks and what it gets, two 48px tiles joined by an arrow
(the app's letter tile, then the connection's mark), and carries the logo at a 14px tile, muted, at
its foot. The marketing header
uses a 24px tile with 18px capitals.
`logo/wordmark.svg` owns the outlined letters; `../scripts/brand-logo.ts` generates every combined logo and
its shared CSS. Use the generated files and `.brand-logo` (inline SVG) or `.logo` (CSS mask),
never retype the wordmark or size its parts independently. Colour belongs to the containing
surface: the app frame is muted, while the workspace header stays primary.

Use these prebuilt assets; do not recreate a tile with CSS padding or inline paths:

| Use                                                                          | Asset under `brand/logo/`                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Light tile, dark mark: marketing diagrams, MCP server icon, social animation | `tile-light.svg`                                                           |
| Dark tile, light mark                                                        | `tile-dark.svg`                                                            |
| Name with tile                                                               | `openbelt.svg` (current color), `openbelt-black.svg`, `openbelt-white.svg` |
| Standalone mark with no background                                           | `slot.svg`                                                                 |
| Browser tab, optimized for 16–32px                                           | `favicon.svg`, `png/favicon-16.png`, `png/favicon-32.png`                  |
| Installed app icon (PWA, Android)                                            | `png/icon-192.png`, `png/icon-512.png`, `png/icon-maskable-512.png`        |
| iOS home screen, platform supplies corners                                   | `png/apple-touch-icon.png`                                                 |

`logo.markRatio` is 0.54: the mark occupies 54% of the tile, leaving 23% padding on each side.
Keep this ratio during animations; scale and move the complete asset. For canvas drawing in the film,
use the injected `BRAND.markRatio` and `BRAND.tileRadius` with the shared `K.slot` drawing helper.
Overall display sizes can vary by placement.

Only browser tabs use `logo.faviconMarkRatio` (0.62, 19% padding) for small-size legibility.
Do not use the favicon for MCP server icons or larger illustrations. The SVG favicon has a dark tile
and light mark in light mode, reversing in dark mode. PNG favicons match its light-mode colors.
The app icons (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`) are
Ink: a pure black tile and a silver mark that fades from white at the top to grey at the bottom
(`logo.appIcon`), so the icon sits well among the black and silver icons on a home screen. The tile
can take a gradient too (top and bottom colours, reaching the bottom 70% of the way down). The
maskable icon is a full square: Android cuts its own shape, and the 54% mark stays inside its safe zone.

`bun run brand sync` generates the tile SVGs, favicon, PNGs and wordmark tile geometry from these
values. `bun run brand check` rejects changed geometry, colors or stale consumer copies.

Scope: marketing (`www/`) and the platform's own pages (a workspace's home page, the default favicon).
Apps people build on OpenBelt look however they like.

Words on these surfaces (copy, labels, buttons, empty states) follow [WRITING.md](WRITING.md).

## Colors

Mono. The accent is the text colour: ink on paper in light, paper on ink in dark. The slot is
always the text colour.

- **Primary (#0c0b0a, dark #f8f7f3):** text, primary buttons, the slot, focus rings.
- **Neutral (#fffefb, dark #0c0b0a):** the page. Warm paper, never pure white or black.
- **Backdrop (#fffefb, dark #000000):** the marketing page only, a step below neutral, so its
  windows and cards read as lit. The one pure black.
- **Surface and subtle:** raised panels and the selected item. One step off the page, no more.
- **Sidebar and sidebar-selected:** inset pages (the gallery, Settings) are two-tone: the window
  is the sidebar tone and the sidebar sits straight on it; the content is a neutral panel inset
  8px from the window's top, right and bottom (its left meets the sidebar), with the lg radius
  and no border (the tone step is its edge), scrolling inside itself. Below 820px the content is full-bleed and the sidebar a
  drawer, rounded on its right. The selected item is one step further (sidebar-selected); hover
  is subtle. A menu that opens from the sidebar stays on neutral, so it stands out from it.
- **Border and border-strong:** border for dividers, containers and read-only fields; border-strong for the outline of every control (inputs, selects, segmented controls, secondary buttons), so controls side by side match.
- **Muted (#6f6a5f, dark #a39e91):** secondary text, captions, metadata. Body copy stays primary.
- **Success, warning, error:** status only, muted, and always with an icon or a label (colour is
  never the only signal). Never decoration, never brand.
- **Highlight (#856000, dark #ffd43b):** the hand-drawn underlines in the marketing hero, and
  nothing else. Never text, fills or the product UI.

## Typography

Inter Tight for headings, Inter for everything people read, JetBrains Mono for
code, commands, paths and numbers that line up. The wordmark is Geist, outlined in `logo/` (never set
as text). The scale is a major third (1.25) from 14px.
Headings are 650 with tight tracking; body is 400. Sentence case everywhere, including buttons
and headings. The product name is OpenBelt; commands, packages and paths stay `openbelt`.

Marketing headings may scale down on small screens (`clamp()`), never up past their token. The
marketing hero's headline is the one hero-size line, about 104px on a desktop.

## Layout

A 4px grid. Controls are 32px tall, 40px below 820px or on a touch screen, where a field's text is 16px (under 16px, iOS Safari zooms into the field when it takes focus); there is one button size. Content columns cap at 1080px (marketing), with 24px side gutters (16px on phones). The marketing hero is centered:
the headline, one line, the prompt to copy, and the examples that fill it. Everything else is left
aligned. Marketing sections are 192px apart (128px on phones); a heading is 16px from its line and
48px from its content.

The hero's headline names an agent in a chip set into the line: the subtle tone, half the
headline's size, centred on its x-height, the agent's mark before its name. Names roll through it
in turn, and it eases to each one's width.

## Elevation & Depth

Surfaces separate with a 1px border or one tonal step (surface, subtle),
the same on every side: never a coloured or thicker rail down one edge.
A gallery card's picture sits in a panel tinted with the app's own colour (14% of it over surface, 28% in
dark), padded on three sides and cut off at the bottom; the picture has a soft shadow (0 2px 10px at 12%
black) and its name, description and owner sit under the panel, on the page. Hover lifts the panel by 2px.
The app colours are the apps', not OpenBelt's: one an app gives itself, or one of twelve hues made from its name.
Other shadows are on overlays (dialogs, menus, toasts, a drawer) so they read above the page;
a drawer or dialog also dims the page behind it with `.scrim`. Dark mode uses the same borders,
not glows.

## Shapes

Soft but square: 6px on controls (buttons, inputs, menus), 10px on cards and panels, 12px (lg)
on the inset content panel and the drawer, full round only for badges and toggles. A gallery card's
panel has iOS's continuous corner (`corner-shape: superellipse(1.3)`) where the browser draws one, its
corner 13% of the card's width (9.5% on the wide featured app, never under lg), so narrow and wide cards share
one shape; the picture's corner is the panel's less its padding. Elsewhere it falls back to a round corner,
10% of the width (7% on the featured app). Icons are Lucide, round caps, 1.5 stroke, 16px in UI and 20px in
marketing.

## Components

Plain HTML plus the classes in `css/components.css`: `.btn` (`.btn-primary`, `.btn-secondary`,
`.btn-ghost`), `.input`, `.card`, `.badge` (`.badge-success`, `.badge-warning`, `.badge-error`),
`.kbd`, `.code`, `.icon`, `.empty`, `.logo`, `.select`, `.field`, `.copy-field`, `.list`,
`.notice` (`.notice-success`, `.notice-error`), `.menu` (`.menu-item`, `.menu-sep`,
`.menu-choice`), `.scrim`. A component that isn't there yet goes into `components.css` first, then into
pages.

## Motion

140ms, ease-out (`cubic-bezier(0.2, 0.8, 0.2, 1)`), for hover, press and open. Nothing loops,
nothing bounces, except the marketing page's demo (the headline's agent, the example playing, the
logo rows, the hero's floating marks), which loops only while it's on screen. A press shrinks a control to 96% and darkens it.
With reduced motion, durations drop to 0 and the demo holds still.

## Do's and Don'ts

- Do use the logo files. Don't retype, recolour, stretch or outline the wordmark.
- Don't colour the slot or put it on a gradient. It is the text colour.
- Do pair status colour with an icon or label. Don't use status colours for anything else, except in
  the marketing page's drawings (the built-in pieces and the team tiles): each piece's moving parts
  take one accent from success, warning or the `art-*` colours, and the team tiles show statuses in
  status colours. The `art-*` colours are for those drawings only.
- Don't add a second accent colour (highlight is only the hero's underlines, `art-*` only the
  marketing drawings), gradients, glows or
  shadows on resting surfaces other than a gallery card's picture. An app's own colour tints only its
  gallery panel.
- Don't mark a notice, panel, card or row with a gutter rail (a coloured or thick left or right
  border, or an inset shadow down one side). Say the status with an icon and words (`.notice`), a
  `.badge`, or a heading; surfaces keep the same 1px border all round. `bun run brand check`
  refuses a rail.
- Do use tokens (`var(--openbelt-*)`). Don't write raw colours or off-scale radii in page CSS.
- Don't use more than two weights on a screen (400 and 650; 550 for labels).
- Do write "OpenBelt" in prose and UI, and `openbelt` in code formatting.
- Do call what people build apps, in prose and in code.
