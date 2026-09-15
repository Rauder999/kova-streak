# The Gate

A push-your-luck sink for chain links, in the System's language. Built
2026-09-15 on Rauder's brief: "think about how gambling could work, answer
the abuse questions yourself, then build it."

## The loop

Close the day's quest and the Gates open for you. You pick one of three and
descend rank by rank: **E, D, C, B, A, S**. Every rank you clear raises what
the Gate owes you. Every rank is less likely to let you through than the one
before. At any point you walk out with what you are holding. Fail a rank and
the Gate collapses with your entry inside it.

Clear the S-rank floor and the System's Vault, everything it has skimmed
since the last time anyone got that deep, is yours on top of the payout.

| Rank | Survive | Reach it | Lesser (3) | Greater (5) | Monarch's (8) |
|------|---------|----------|-----------|-------------|---------------|
| E | 90% | 90.0% | 3 | 5 | 8 |
| D | 80% | 72.0% | 4 | 6 | 10 |
| C | 70% | 50.4% | 5 | 9 | 15 |
| B | 60% | 30.2% | 9 | 15 | 25 |
| A | 50% | 15.1% | 19 | 31 | 50 |
| S | 40% | 6.0% | 25 + Vault | 42 + Vault | 68 + Vault |

## Why these numbers

Payouts are whole links written out by hand, not a multiplier applied to a
stake. That is not decoration. The first version of this used multipliers,
and the maths check caught that a 1.9x rounds to exactly 2.0x on every legal
stake, which made stopping at C-rank return 101% and turned the Gate into a
slow link printer. Integers are the only honest unit when the currency is an
integer.

Every floor of every gate returns between 84% and 96% of what it costs to
reach, so no depth beats another by enough to matter and none of them beats
breaking even. There is no strategy to find. The only real choice is how far
you push tonight, which is the choice worth talking about in the channel.

The S-rank floor is deliberately the worst deal on the board on its own, at
about 50%. What makes it worth reaching is the Vault, which is fed by
everything the Gate keeps. The Lesser Gate's last descent becomes a fair bet
once the Vault passes 22 links, the Greater's at 37, the Monarch's at 58. So
the Vault fills quietly until somebody decides it is finally worth the jump,
and empties when they make it. The deal repairs itself, and nothing is
printed or burned: the Gate only moves links around the group.

## What stops this from going wrong

**It cannot replace training.** The Gate only opens on a day you have
already closed. No completed quest, no Gate. Gambling is the reward for
training, never a substitute, and an alt account would have to do the work
anyway.

**It cannot spiral.** At most 3 runs and 12 staked links a day. The worst
possible night costs 12 links, and the expected cost of playing the daily
allowance to the hilt is about one link. Nobody can tilt away a month of
work at 3am.

**It cannot move the leaderboard much.** Links reach the ranking only
through the exchange's score point at 30 links each, and every floor of the
Gate returns less than it costs. Winning big is a story, not a ladder.

## The cheating questions, answered

**Can the client roll its own dice?** No. Every roll happens in the Worker
with `crypto.getRandomValues`. The client is told one rank at a time and
never learns anything it has not already paid for.

**Can someone reroll a bad floor?** No, and this is the load-bearing part.
The whole run is decided at entry: the server rolls how deep this run will
go, stores that depth where only it can see, and each descent reveals one
more rank of a result that already exists. Refreshing, disconnecting, firing
ten parallel requests, none of it changes a number that was written before
the first rank was shown. A KV store has no transactions, so the only safe
design is one where concurrency has nothing to race for.

**Can someone pay once and run twice?** Entry refuses while a run is open,
and the stake leaves the balance before the run is created. A run abandoned
half way stays abandoned, with the stake already gone.

**Can someone collect a payout twice?** Every payout carries the run id, and
the ledger refuses a second entry with the same id. Two tabs racing an
extract produce one credit.

**Can someone predict the rolls?** The pairing RNG in this codebase is
seeded and deterministic by design, and it would be predictable. The Gate
does not use it.

**Can two players funnel links to one?** There is nothing to funnel with.
The Gate is single player, and the project has no player-to-player transfer.

**Can someone farm the Vault?** The pot only pays on an S-rank clear, which
is a 6% shot at the end of a run most people leave long before. The daily
caps bound how many shots exist per day across the whole group.

**Can the day roll over twice?** Entries are counted against the group's
day in Denver, the same day every other counter uses.

**Can a rebalance rob somebody mid-run?** No. The payout ladder is copied
into the run at entry, so changing the numbers later never touches a descent
already in progress.

## Where it lives

- `gate:run:{uid}` the open run: gate, entry, its frozen payout ladder, the
  revealed floor, and the hidden depth.
- `gate:day:{uid}:{date}` today's spend: runs and links staked.
- `gate:pot` the Vault.
- `gate:closed` set by the admin to shut the Gate for everyone.

The maths is checked by `scratchpad/gate-math.mjs`, which reads the constants
straight out of the Worker, so the table above cannot quietly drift away from
the code. The endpoints are covered by the chain e2e suite.

## Not built yet

Rauder's own next idea: loot boxes holding cards that act on other players,
sabotage and the like. That is a bigger design with a real abuse surface of
its own, since a card that hurts someone else can be aimed at whoever leads
the month. It needs its own brief before anything is written.
