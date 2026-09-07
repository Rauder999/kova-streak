# Chain Protocol: pairs, links, the vault, the weekly trial

Product spec agreed with Rauder, 2026-09-07. Not implemented yet; this
document is the source of truth for the mechanics. Design language for
all of it lives in KOVA_design_brief.md (System voice, chain map as a
constellation on the dimension background).

## 1. Daily chains

- Every group day, ALL participants (actives and ghosts alike) are
  paired. Pairing is a deterministic shuffle seeded by the date, so
  every client and the worker derive the same pairs with no stored
  state. Constraint: never the same partner as the previous two days
  (derivable from the previous days' seeds).
- Odd headcount: exactly one TRIPLE that day (never a bye). A triple
  completes only when all three complete.
- A chain FORGES when every member completes their playlist that day.
  Reward: +1 link each (see the ledger).
- Rescue bonus: if a member was silent 3+ days before today (same
  idleDays logic as the digest), the chain pays DOUBLE to everyone in
  it. Reviving a ghost is a jackpot, not a burden.
- A partner on a scheduled rest day counts as holding their end: the
  playing member can still forge the chain (no rescue bonus from
  resting partners).
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
| Extra rest day | One additional rest day usable in a week where both weekly rest days are spent. Cap: 1 per month. | 12 links |
| Streak Shield | Held in inventory (max 1). If a day ends with NOTHING played, at 03:30 group time the shield auto-converts that day into a rest day: streak survives, day is not credited as done. Consumption is public: the digest reports it. | 25 links |

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

Bottom of the Group page: `[CHAIN MAP // <date>]`. Today's chains as a
constellation on the dimension background: avatar nodes joined by a
thread. Thread states: forged = gold glow, waiting (some ends done) =
purple ember, open = dim, broken (day over, incomplete) = gray. Triples
draw as triangles. Hover shows who holds which end. No pair streak
exists (pairs rotate daily), so no size scaling by streak; motion and
glow carry the states.

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

- New joiner enters the pairing pool on their first group day (they
  are part of "all participants" immediately).
- A removed player breaks out of the pool instantly; their partner
  that day gets the chain task auto-credited (not the day itself).
- Pairing pool = the digest roster (players with at least one
  completed day ever) PLUS never-cleared players: chains deliberately
  include ghosts, that is the point. Spectators with zero runs ever
  stay excluded everywhere as before.
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
