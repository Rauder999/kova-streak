# Chain Protocol: pairs, links, the vault, the weekly trial

Product spec agreed with Rauder, 2026-09-07. Not implemented yet; this
document is the source of truth for the mechanics. Design language for
all of it lives in KOVA_design_brief.md (System voice, chain map as a
constellation on the dimension background).

## 1. Half-week chains

- ALL participants (actives and ghosts alike) are paired in HALF-WEEK
  windows: Monday-Wednesday (3 days) and Thursday-Sunday (4 days).
  Two shuffles a week (the middle ground Rauder asked for: daily was
  too short to actually pressure a partner, weekly too stale).
- Pairing is a deterministic shuffle seeded by the window key, so
  every client and the worker derive the same pairs with no stored
  state. Constraint: never the same partner as in the previous two
  windows (derivable from the previous window seeds).
- Odd headcount: exactly one TRIPLE that window (never a bye). A
  triple's day forges only when all three complete.
- Within a window the pair is fixed. EACH DAY both members complete,
  the chain forges that day: +1 link each.
- Perfect chain: every day of the window forged together pays a bonus
  +2 each at window close.
- Rescue bonus: if a member was silent 3+ days at the window's start
  (same idleDays logic as the digest), every forged day of that chain
  pays DOUBLE. Reviving a ghost is a jackpot, not a burden, and a
  multi-day window gives the rescuer real time to hound them.
- A partner on a scheduled rest day counts as holding their end for
  that day: the playing member can still forge it (rest days do not
  count toward the perfect-chain requirement; a window day resting
  on BOTH sides simply does not count against perfection either).
- Nothing is lost on a broken chain. No penalties, only missed upside.

## 2. Links (the currency)

- KV ledger per player. Earned: chain forged +1, rescue chain +2,
  weekly trial participation +1, weekly trial win +5 (numbers are
  launch defaults, tunable).
- Links NEVER touch the main ranking (days completed stays sacred).
  They act as the monthly tie-breaker: equal done days, more links
  wins.
- Shown on the site (leaderboard column and/or the chain map).

## 3. The Vault (the shop)

System-voice framing, not a casino: `[THE VAULT]`. One purchase flow,
inventory in KV. Launch catalog:

| Perk | Effect | Price (launch) |
| --- | --- | --- |
| Frame of Honor | An OPERATOR frame around your avatar on the leaderboard for 7 days. Pure prestige. | 5 links |
| Extra rest day | A one-use voucher: schedule ONE rest day ignoring the 2-per-week quota. At most one voucher used per calendar month, so a single week of the month can reach 3 rest days and no week can ever exceed that. | 12 links |
| Streak Shield | Held in inventory (max 1). If a day ends with NOTHING played, at 03:30 group time the shield auto-converts that day into a rest day: streak survives, day is not credited as done. Consumption is public: the digest reports it. | 15 links |

Shield notes: it fires only after the 3-hour night grace window has
closed (no double-crediting confusion), it is consumed automatically
(no choosing to save it), and the digest line keeps it honest:
`[X's Streak Shield absorbed the miss. The chain of days holds.]`

## 4. Messaging (replaces individual announces)

- Individual completion announces (X completed, streak N) are REMOVED
  to cut channel noise. Records pings and the 18:00 digest stay.
- Partner-finished ping: the moment one end of a chain completes, the
  other member(s) get ONE ping:
  `[@X. Prinz has held his end. The chain waits on you.]`
- Chain forged: when the last member completes, one message pings all
  members: `[CHAIN FORGED // Rauder x Prinz]` +
  `[Both ends held. +1 link each.]` (triple: all three names).
  - v1 ships as a rich embed with both avatars.
  - v2 renders a PNG in the worker (resvg-wasm): avatar left, avatar
    right, a glowing chain between, the caption. Attached to the
    message.
- Digest additions: `[Chains forged today: N/M.]`, shield consumptions,
  and on Sundays the weekly trial resolution.

## 5. The chain map (site)

Bottom of the Group page: `[CHAIN MAP // <window>]`. The current
window's chains as a constellation on the dimension background: avatar
nodes joined by a thread. Today's thread states: forged = gold glow,
waiting (some ends done) = purple ember, open = dim, broken (day over,
incomplete) = gray. The window arc is visible too: the thread thickens
and brightens with each forged day of the window (1/3, 2/3...), a
perfect-chain-so-far pair burns gold. Triples draw as triangles. Hover
shows who holds which end and the window tally.

## 6. The weekly trial (challenge)

- One scenario from the current playlist becomes the TRIAL for the
  week, announced with the Monday playlist publish
  (`[WEEKLY TRIAL // <scenario>]`).
- Winner = the largest PERCENTAGE improvement over your own personal
  best as snapshotted at announcement time. Self-relative, never
  absolute score: the ethos holds.
- Anti-abuse: the baseline is the PB snapshot taken at announcement.
  PBs are monotonic, so sandbagging is impossible. A player with no
  prior PB on the scenario sets a baseline this week and becomes
  eligible next time that scenario rolls around.
- Everyone who beats their snapshot at all earns +1 link (once per
  week). The top improver takes +5 links and the digest headline:
  `[TRIAL COMPLETE // X improved 11.4%. The System took note.]`
- Cadence decision: WEEKLY, not daily (recommended and pending final
  confirmation): chains carry the daily dopamine, the trial carries
  the weekly arc and gives Sundays a finale.

## 7. Edge rules

- The pairing pool freezes at the window start (players with at least
  one run BEFORE it): a mid-window newcomer never reshuffles anyone's
  partner and joins at the next window boundary, 1-3 days later.
- A removed player breaks out of the pool instantly; their partner
  that day gets the chain task auto-credited (not the day itself).
- Pairing pool (revised 2026-09-10): active roster players with at
  least one fully closed day before the window start AND at most 5
  non-rest days of silence at that point. Silent 3-5 days = cold, the
  pair pays double (the rescue). Silent longer = no partner this
  window: in the first live window three of six pairs had a ghost
  partner who never showed up and the active half earned nothing.
  Spectators with zero runs ever stay excluded everywhere as before.
- Rest days, grace window (3h), yesterday-healing and admin credits
  all interact with chains through the same completion records; a
  healed yesterday forges yesterday's chain retroactively if it
  completes it, awarding links late but never re-announcing past
  chains louder than a digest line.

## 8. Rollout phases

1. Core chains: pairing, forging detection in the completion flow,
   partner ping, chain-forged embed (v1), links ledger, digest lines,
   individual announces removed, chain map on the site.
2. The Vault: purchase flow, Frame of Honor, extra rest day, Streak
   Shield with its 03:30 cron.
3. Weekly trial + PNG chain art (resvg-wasm) + economy tuning after
   two weeks of real data.
4. Roster Protocol (below).

## 9. Roster Protocol (2026-09-10)

Silence = non-rest days without a fully closed day, counted from the
last closed day, or from the join date for a newcomer who never closed
one, or from the reinstatement date.

- 14 silent days: the System serves a FINAL NOTICE by bot DM (if DMs
  are closed, the same block lands in the channel with a mention).
  This is your last day: close today and the notice is void.
- Still silent the next morning (03:30 group time, right after the
  shield sweep): removed from the roster. A removal DM explains the
  way back. History is kept, nothing is deleted.
- Removed players vanish from the live leaderboard, the digest, the
  denominators and the chain pool; their end of a running chain reads
  as held, so a partner left alone still forges. Past months keep them
  in the history view.
- The way back runs through Rauder on purpose: the player messages
  him, he presses Reinstate in the admin panel (Roster card). A
  reinstated player is back on the board at once with a fresh two
  weeks on the clock, and back in the chains at the next window after
  their first closed day.
- Anyone already past the line when the protocol shipped got the
  notice first; nobody is removed without one served the day before.
- The digest names both events: `[Final notice served to X. One day
  remains.]` and `[Removed from the roster: X. Two weeks of silence.
  The System does not chase.]`. Players on notice are not repeated in
  the silent line the same evening.
