# KOVA design brief: The System's Interface

Direction chosen by Rauder, 2026-09-06: **A (System terminal) as the base,
C (OPERATOR guild assets) as the ceremonial layer.** This document is the
source of truth for the redesign. Mockups and implementation follow it;
deviations get discussed first, then written back here.

## 1. Concept

The site IS the System: the same cold, procedural, all-seeing entity that
posts in the Discord channel. It scans, verifies, records and occasionally
honors. The player is inside a diagnostic interface, not on a SaaS dashboard.

The OPERATOR pack is the System's award vault. Guild frames, banners and
metals appear ONLY when the System honors someone: podium, milestones, the
100% ceremony, month winners. Scarcity keeps them ceremonial: guild assets
never decorate tables, forms or utility UI.

One voice across surfaces: the site, the Discord bot and the coach speak the
same System. Where wording overlaps, reuse the bot's exact phrases
("Day secured.", "The gate is open.", "The System took note.").

## 2. Voice rules (UI copy)

- The System speaks STATES and EVENTS: bracketed mono lines for statuses,
  eyebrows, verdicts. `[DAY SECURED]`, `[SCANNING FOLDER...]`,
  `[GROUP // SEPTEMBER 2026]`, `[COACH DIAGNOSTIC]`.
- Humans read EXPLANATIONS: setup steps, help text, rest-day rules stay in
  plain English (Space Grotesk), never bracketed.
- Rough budget: per screen, one bracketed eyebrow per section plus status
  chips. If everything is bracketed, nothing is.
- Never emoji. Never em dashes. English only.
- Error and empty states are System lines too: "[NO SIGNAL FROM FOLDER.]"
  beats "Something went wrong".

## 3. Color tokens

Evolves Obsidian Signal. Base stays, ceremony layer gets formalized.

```
--bg-0:      #08070C   page ground
--bg-1:      #121216   surface / card
--bg-2:      #1A1A20   raised surface, code chips
--line-0:    #26262C   hairline inside cards
--line-1:    #3A3A3E   card borders
--text-0:    #F2F2F2   primary text
--text-1:    #9A9AA0   secondary text (raised from #8A8A8E for contrast)
--text-2:    #6E6E74   tertiary, sparingly, 13px minimum
--signal:    #7C6CF0   the System's presence: focus, accents, glow
--signal-soft: #B7AEF7 System text lines, links
--pass:      #6FA37A   THE product color: completed day, done pills
--fail:      #C96A5E   missed, errors
--warn:      #C9A45E   cautions, partial-adjacent messaging

Ceremony (OPERATOR layer only):
--honor-gold:   #E8B64A
--honor-silver: #C7C7CC
--honor-bronze: #B08D57
```

Glow rules: purple glow marks the System acting (focus, active window,
live scan). Green glow marks a secured day (today's cell, completion
moment). Metal glows belong to ceremony only. Never two glows compete in
one viewport region.

## 4. Typography

Same pair, wider scale. Mono = the System speaking and all data.
Grotesk = human prose.

```
display   Space Grotesk 700   30-34px   one per screen, the hero line
h2        Space Grotesk 500   19-20px   section titles
body      Space Grotesk 400   15px/1.6  explanations
sys       JetBrains Mono 400  12px      bracketed lines, letter-spacing .06-.08em
data      JetBrains Mono 400  by role   numbers, always tabular-nums
caption   13px floor sitewide. Nothing below 13px, ever (audit: 11px labels).
```

## 5. Structural language

**The status window** is the signature container: a bg-1 panel with a
1px line-1 border and CSS corner ticks (short L-shaped strokes in the four
corners, signal-colored on active windows, line-1 on resting ones). Title
sits in the top edge as a mono tab: `[COACH DIAGNOSTIC]`. Optional 1px
scanline texture in the header strip only. This replaces the anonymous
rounded card as the default panel.

**One hero per screen.** Group = the podium. Today = the day status window
(ring + count). Stats = the coach diagnostic. Login = the product proof.
Everything else on the screen is visibly subordinate: smaller, quieter,
denser.

**Kill the voids.** Content column widens to ~960px. The grid horizon
background either earns its place (visible near the header, fading by
mid-screen) or leaves. Pages end with a System footer line
(`[KOVA STREAK // SEASON 1]`) instead of trailing black.

**Density.** Cards sit closer (16-20px gaps, not 40), padding tightens,
done-scenario rows compress. The terminal feel comes from crisp density,
not from emptiness.

## 6. Per-screen prescriptions (from the audit)

**Login.** Show the product: a live-looking strip of the group calendar
(green cells glowing) or the podium render behind the pitch. System boot
line on top: `[KOVA STREAK // GROUP TRAINING PROTOCOL]`. Fix the stale
copy: ranking is most days completed. One purple CTA.

**Today, in progress.** Hero = day status window: the ring (thicker,
brighter) plus `[DAY 33% // 10 OF 30 RUNS]` in mono, streak and group
stats as a readout row inside the same window, 13px labels. The
troubleshoot line moves to a quiet footer link ("Progress stuck?").
Checklist splits: remaining scenarios first at full strength, completed
ones collapse into a dim compact block below. Rest days card keeps its
place, chips get System styling.

**Today, setup gate.** Steps become numbered status rows with mono
numerals and distinct step titles; the card holds the page center without
a two-screen void below (footer line closes the page). Rest card visible
even before the folder connects.

**Group.** Podium is THE hero pass: frames scale up, metal recolors
brighten (gold must read gold on bg-0), each frame gets its metal glow,
pedestals get real metal edge gradients and hold ties without overflow
(frames shrink before they outgrow the pedestal), flame and day count
scale up. Hero tiles become one System readout strip:
`[CHECKED IN 6/20] [RUNS TODAY 214] [TOP STREAK 12D AMAZINASTRO]`.
Leaderboard: me-row gets a signal left edge, medal ranks get metal
numerals worth seeing. Calendar: partial cell color shifts to a
desaturated purple FILL while today keeps an OUTLINE (never both same
hue at same strength), weekly separators strengthen, future cells drop
to near-invisible, legend to 13px. Month navigation chevrons stay quiet.

**My stats.** Coach card becomes the `[COACH DIAGNOSTIC]` status window:
verdict chips per niche (colored by code severity), assignment lines in
mono, "Same focus as yesterday" rendered as a repeat marker. Day chips
become mono date tabs. Tables keep tabular-nums.

**Celebration.** Stays as mechanics (orbs, sounds, kill rates). Visual
pass: orbs brighter at spawn (rim light), caption scales up in mono,
completion moment flashes a gold OPERATOR frame around the final score
line. This is the one place ceremony and terminal fully merge.

**Admin.** Styled file input, System eyebrows. Lowest priority: one
viewer.

## 7. Motion

Three ideas maximum, all subtle, all behind `prefers-reduced-motion`:

1. System lines decode on first paint (fast scramble-to-text, 300ms,
   once per page load, eyebrows only).
2. Scanline shimmer drifting through active status-window headers,
   barely visible.
3. Green pulse on the moment a day completes (calendar cell / ring).

Nothing else moves. The podium does not float, cards do not lift on
hover beyond a border brightening.

## 8. Craft floors

- Contrast: body text vs its surface >= 4.5:1, secondary >= 3:1.
- 13px minimum text. Tabular numerals wherever digits align.
- Focus states: 2px signal outline, visible on dark.
- All System lines share one CSS class pair (`.sys`, `.sys-window`):
  the voice is a system, not per-page hand styling.

## 9. Rollout

1. Mockups of Group in this language (design canvas, 2-3 variants) ->
   Rauder picks.
2. Implement Group -> approve -> Today -> Login -> Stats -> Celebration
   -> Admin.
3. Each screen ships behind Rauder's approval. Tokens land first as a
   css/style.css evolution, not a rewrite: existing class names survive
   where possible.
