# The Gate

A gate in the System's world locks its hunters inside until it is cleared.
This one is the group's gambling table, built 2026-09-15, rebuilt on keys
2026-09-16 and given its rare red variant the same day, all on Rauder's
brief.

## The loop

Close the day's quest and the System cuts you a **key**. One key a day,
three held at most, never traded. Turn a key and the Gate opens.

You descend rank by rank: **E, D, C, B, A, S**. Every rank you clear raises
the share of the Hoard you are allowed to walk out with, and lowers your
odds of seeing the next one. Leave whenever you like. Fail a rank and the
Hoard keeps what you were holding.

| Rank | Through | From the door | You may claim |
|------|---------|---------------|---------------|
| E | 90% | 90.0% | 1 |
| D | 80% | 72.0% | 2 |
| C | 70% | 50.4% | 4 |
| B | 60% | 30.2% | 7 |
| A | 50% | 15.1% | 14 |
| S | 40% | 6.0% | the whole Hoard |

## Red gates

**One key in twenty tears open red instead.** Same six ranks, same ten
passages, but every rank keeps one more of them shut and every rank pays
several times over.

| Rank | Through | From the door | You may claim |
|------|---------|---------------|---------------|
| E | 80% | 80.0% | 2 |
| D | 70% | 56.0% | 5 |
| C | 60% | 33.6% | 12 |
| B | 50% | 16.8% | 28 |
| A | 40% | 6.7% | 70 |
| S | 30% | 2.0% | the whole Hoard |

The prices rise faster than the odds fall, on purpose. Stopping at the E
rank of a red gate is worth 1.6 links on average and pushing to the A rank
is worth 4.7, where the ordinary ladder is flat at about 2.1 from the C
rank down. So in a red gate the deep ranks are the best deal on the board,
which is the only thing that makes a rare gate worth taking risks in, and
the forfeit is on the same scale: a red B rank that turns you away hands
the Hoard 28 links back.

None of this mints anything. Red gates draw from the same Hoard under the
same cap, so they change who empties it and how fast, never how much there
is. Across a 400 day simulation they account for one to four percent of all
payouts. Which gate you got is rolled by the Worker at entry with the same
coin as the passages, and nothing the client sends can ask for a red one.

The roll is advertised everywhere rather than hidden: the hall states the
odds and the A rank's price, the ladder carries the red column beside the
ordinary one, and the descent opens on a stamp naming the gate and its
terms. The anticipation is the feature.

## Why keys and not links

The first build charged links, three to eight of them. The ledger said that
was impossible: links arrive at about one a day and the exchange is priced
against a month of them, so every link staked was a day of progress toward
a shield. Gambling felt like self-harm because it was, and the players with
none, a newcomer or somebody just back, could not play at all.

Keys fix all of it at once. The fuel is training, not wealth. A newcomer
descends on their first closed day. Nobody can lose savings they spent a
month on, because the only thing at risk is a key that arrives free
tomorrow. And the exchange is left exactly as it is.

## The Hoard

Everything the Gate pays comes out of the Hoard, and nothing is minted, so
**the group's link supply grows by exactly what feeds the Hoard and not a
link more**. Two things feed it:

- one link a day, plus one for every player who let the day go (scheduled
  rest is not a miss, and players who have never played are not counted);
- whatever a hunter was holding when a rank gave way.

The first is new money, about five links a day at the group's current form.
The second is not: it is the players' own winnings going back in the pot.
That second rule is not flavour. Without it the Hoard was drained to zero
permanently and about half of all payouts had to be cut short; with it a
simulation of four hundred days trims about five percent, and the Hoard
breathes between empty and a hundred.

The S rank takes whatever is left of the Hoard. So the last descent is
worth making only while the Hoard is fat, and the Hoard is fat only because
nobody has got that deep lately. The deal repairs itself, and the number is
public in the Gate window and in the digest, so everyone can see when it is
finally worth the jump.

## What stops this from going wrong

**It cannot replace training.** No closed day, no key.

**It cannot spiral.** One key a day, three held. The worst night costs
three descents, and a descent costs nothing but the key.

**It cannot print links.** Payouts come out of a pot fed at a fixed rate.

## The cheating questions, answered

**Can the client roll its own dice?** No. Every roll happens in the Worker
with `crypto.getRandomValues`. The seeded RNG this codebase uses for chain
pairing is predictable by design and is never used here.

**Can someone reroll a bad rank?** No, and this is the load-bearing part.
The whole descent is decided at entry: the server rolls how deep it goes,
stores that depth where only it can see, and each descent reveals one more
rank of a result that already exists. Refreshing, disconnecting, firing ten
parallel requests, none of it changes a number written before the first
rank was shown. A KV store has no transactions, so the only safe design is
one where concurrency has nothing to race for.

**Can someone descend twice on one key?** The key is spent before the
descent exists, and entry is refused while a descent is open.

**Can someone collect twice?** Every payout carries the descent's id and the
ledger refuses a second entry with the same id.

**Can someone farm keys?** A key is cut once per date, however many times
that day's completion is posted, and only for a day actually closed.

**Can two players funnel to one?** Keys are not tradeable and the project
has no player-to-player transfer.

## Where it lives

- `gate:run:{uid}` the open descent: revealed floor and the hidden depth.
- `keys:{uid}` keys held and the dates already paid for.
- `gate:hoard` the pot.
- `gate:fed:{date}` the marker that keeps the daily feed to once a day.
- `gate:closed` set by the admin to shut the Gate for everyone.

The economy is simulated by `scratchpad/gate-math.mjs`, which reads the
constants straight out of the Worker. The endpoints are covered by the
chain e2e suite: keys, the sealed Gate, no second entry, no reroll after a
collapse, no double payout, and the Hoard balancing on every path.

## The look

The Gate has its own tab, not a window in the Vault: a key costs a whole
day of training, so the screen that takes it is the hall, one canvas and
exactly one control in front of it. A flat outline on a dark rectangle
reads as a wireframe, which is what the first pass of that screen was, so
the hall is built instead: the mouth is a corridor of nested arches
receding to a vanishing point with the Hoard burning at the far end, the
stone has an outer frame and an inner reveal with a rune frieze in the
band between them, the legs stand on plinths, and the floor carries the
arch's reflection, the light it spills and lines running back to the same
vanishing point. The ladder and the terms under it are flat and still, one
accent, rows, the way the constitution asks.

The descent is an **event**, and the constitution leaves event motion
free, so it takes the whole screen: a shaft with six rune seals receding
to a vanishing point, the rim of your own seal answering while you stand
over the mouth you picked, and then the fall. The cleared seal burns
violet behind you; the one that turns you away goes red and throws you
back up the shaft. A red gate repaints all of it vermilion from one
palette, and in there a rank that turns you away flashes white, because
red on red says nothing. Sound is synthesized, nothing is loaded over the
network, and reduced motion skips straight to the verdict.

Below the D rank something can take hold of you: five clicks break it, a
lost grip drags you out with what you were holding. It fires once per
descent at most and about one descent in five, because a jumpscare that
happens every floor is a chore.

A descent left open survives a reload, because the whole map was rolled at
entry and lives in the Worker. Reloading is not an escape hatch either: a
rank that turns you away is settled the moment you pick the passage, so
the key is spent and the run is deleted before any of the animation runs.
On the next load an open descent pulls you straight to this tab.

## Not built yet

Cards and equipment, which is where the deep ranks should eventually pay.
That design is still in discussion: the cards need to act on the group and
enable real bluffing, which is a bigger abuse surface than anything here.
