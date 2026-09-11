# KOVA STREAK design constitution

Derived on 2026-09-11 from Rauder's reference vote (14 references,
yes / partly / no), not from adjectives. It supersedes the visual
sections of KOVA_design_brief.md; the voice sections of the brief stay.

## What the vote said

Yes: the System's own STATUS and NOTIFICATION windows from the anime,
and Raycast. Partly: the System window as a glowing glass object in a
scene, Vercel, Aimlabs, Voltaic. No: dense utility UIs (the KovaaK's
web app, Steam, the ARISE stat dialog, Leetify), the empty-minimal
school (Linear, Cursor) and the dark-plus-one-green SaaS look
(Supabase).

Read together: the site is the System's window, produced with the
polish of a premium dark product. Flat, text-driven, one cold accent,
light only on edges, nothing empty and nothing busy.

## 1. The window is the only component

Every block on the site is a System window: a flat translucent dark
panel, a 1px border, two corner notches in the accent, a label in
brackets in the top-left. Content lives inside windows; nothing floats
between them. There are no cards inside windows, only rows, tables and
readouts.

## 2. Color

- Ground `#0B0D12`. Window `#10141B` at 85% over the ground. Lines
  `#1F2733`, strong lines `#2C3646`.
- Text `#E6EBF2`, secondary `#97A3B4`, muted `#5C6879`.
- One accent per site. Direction A (recommended): System blue
  `#4FC3FF`, deep `#1D8FD9`. Direction B: violet `#8B7CFF`, deep
  `#6A5AE0`. The accent marks the active window, the current tab,
  primary buttons and links. Nothing else.
- Honor metals are medals, not accents: gold `#E8B64A`, silver
  `#C3CAD6`, bronze `#B88A57`. They appear only on the podium, the
  top three ranks, forged chains and DAY SECURED.
- Semantic colors mark state only, as text or a 1px chip border:
  done `#4CC38A`, missed `#E5484D`, rest / warning `#E0B453`.

## 3. Light budget

At most two glowing elements per screen, and glow lives on edges
(a border glow around the active window, a 1px accent line), never as
text-shadow on running text and never as a colored wash under a
block. The background is the flat ground plus a 3% grid; no nebulae,
no stars, no constellations, no ghost windows, no sigils. Decorative
assets from the OPERATOR pack survive only as the podium frames.

## 4. Typography

Three faces, fixed roles:

- Rajdhani 600/700, uppercase, letter-spacing .08em: the System's own
  labels, window titles, section names. This is the voice of the
  interface.
- IBM Plex Sans 400/500/600: everything a human reads, names,
  explanations, buttons.
- JetBrains Mono 500/700: every number, date, code and bracketed
  status line. Digits are always tabular.

Scale (px): 11 labels, 13 data, 14 body, 16 names, 20 section titles,
28 podium numerals, 40 readout numerals. Nothing outside the scale.

## 5. Space and shape

- 8px grid: window padding 24, gap between windows 24, table rows 44,
  chip height 24.
- Radius 0 on windows, 4 on chips and buttons. No pills.
- Borders 1px. Notches 10px.
- Content column 1120px, centered.

## 6. Motion

Ambient motion: at most two per screen (the readout scan line and one
more). Event motion is free: forging, DAY SECURED, a record. UI
transitions 160 to 240ms. Everything else is still.

## 7. What each screen leads with

- Group: the readout (checked in, runs, top streak), then the podium,
  then the leaderboard, then the chain map.
- Today: the day window with the gauge, then the checklist.
- Vault: the balance, then the shop rows.

## 8. The rule for every future request

A new visual ask is checked against this page. If it breaks a rule,
the answer names the rule and offers the in-system way. Restraint is
the point: what reads as expensive is fewer things, placed exactly.
