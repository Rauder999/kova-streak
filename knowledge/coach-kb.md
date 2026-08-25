# kova-streak coach knowledge base

Canonical source for every coach answer. Distilled from 4BangerKovaaks' full FAQ
document, ~200 transcribed videos (via the AimSama knowledge pipeline) and his live
coaching reviews, de-personalized. The worker embeds this text verbatim as the
knowledge section of the coach prompt: keep it prompt-sized and keep worker.js in sync.

## Philosophy (overrides everything)

- The goal is clean technique and habits, never score. Score must be an OUTCOME of good
  technique. A score gain paid for with degraded technique is a regression (Goodhart's law:
  once a metric becomes the goal it stops measuring progress).
- KovaaK's is a habit builder. Bad habits translate into the game 1:1 (overflicking,
  shooting before confirming, edge clicking, edge tracking). Under pressure the brain
  draws only from the pool of flicks you trained; feed it faulty ones and it picks from them.
- Everything is connected (assisting skills): pokeball assists static and TS; TS assists
  static and pokeball; static builds control; smoothness assists reactive and first-shot
  accuracy; tracking assists flicking. When a field is stuck, attack its assisting fields
  instead of spamming it.
- Timings: every method is right at the right stage. Beginners mostly need playtime and
  fundamentals across ALL fields; hyper-specific fixes come later. Most players have 2-3
  core problems that bleed into everything.
- Progress = raising your floor: best and worst aim closer together, roughly 0.01% a day,
  non-linear. Comfortable = maintaining, not training; train with in-game urgency, no autopilot.
- Inconsistency is not a trait, it is a skill gap: the spread between peak and floor.

## Speed management: the core model of why flicks miss

- Peripheral vision plans the initial path (fast, blurry); central vision guides the
  correction (accurate, engages late if allowed). The classic fault: explosive initial
  guided by peripherals only, abrupt halt, freeze (recalculation), slow separate correction.
- The correct flick: eyes on the target BEFORE and DURING the movement, central vision
  engages mid-flick (by 60-80% of the path), deceleration starts before the target, the
  correction BLENDS into the initial: one smooth glide at even speed ("hand through water").
- Speed = MINIMAL WASTED MOVEMENT, not hand speed. 100ms initial + 100ms correction beats
  50ms initial + 300ms correction. Prefer UNDERFLICKING; the correction is a fallback for
  saving a flick, not a standard feature of every flick.
- Flicking fast and adjusting slow teaches the brain that the correction takes forever, so
  in game it sprays around the target instead of adjusting. Fix: equalize the whole flick
  to the correction's speed, then rebuild speed.
- Randomness (shakes, hesitation, dirty micros) = the brain filling gaps with guesswork.
  Cures: intent per movement, decelerations (a millisecond to re-read the path), reading
  the target, looking at the bot before the mouse moves.

## Fields and how to read them

- STATIC CLICKING (builds control; = knowing WHEN to click). Confirmation methods: 100%
  mode (98-100% accuracy runs even at score cost), visual confirm (a millisecond of seeing
  you are on target at ANY speed), clicking the DEAD CENTER (never edges), 4BClick (finger
  off M1, flick, confirm, finger back, click). Punishment scens (never-miss, bardpill) when
  the spam habit is strong. Wide wall = the flick splits into initial + correction, trains
  decelerations. Clustered = raw snap speed, NOT corrections. Missing close-range flicks is
  a lines/speed issue, not a "micro" issue. Accuracy homes: ~95-100% accuracy-focused
  statics, 92%+ speed-focused; speed focus = +10-20% over comfort, never +40-50%.
- POKEBALL (assists static and TS; accuracy of lines). M1 held the whole run, targets are
  static balls; accuracy = time on target, 10-30% is normal, never judged by clicking
  standards. Smooth pathing for overflickers: any speed as long as zero over/underflick,
  one straight line, no correction at the end; drop the technique once consistently landing
  close. Wide-wall pokeball is the main overflicking cure. Progression = tiny handspeed
  bumps, about +5% at a time, never 0-100.
- TARGET SWITCHING (assists static and pokeball; speed). M1 held, let the mouse fly; trains
  the speed of REALIZING where the crosshair is. Large TS = pure speed; small TS = accuracy
  plus blending the flick into a short track. Freeze after the initial flick = slow
  correction routing: low-TTK scens, ballsheet, larger targets. Can't blend flick into
  track: higher-HP / evasive TS, regen switching. Eyes jump to the next target the instant
  the current one dies; hand 10-20% faster than comfortable. Chain kills: minimal time
  BETWEEN targets, a fraction longer ON the target.
- DYNAMIC (clicking moving targets; pasu family, 3-click scens). NEVER spam and never
  pace-push: track the bot for a millisecond before clicking; dynamic is tracking first,
  clicking second, and a longer kill time here is often correct technique, not hesitation.
  Target reading: flick to where the target WILL be, not its old position (flicking to old
  position is the #1 reason for "overflick in game but not in KovaaK's"). 3-click scens
  force tracking priority.
- TRACKING = smoothness. Reactive = recognizing and reacting to a direction change;
  everything before and after the reaction is smoothness. Read the target: if he is smooth,
  be smooth; be reactive only for the millisecond of the change (constant reactivity =
  shakes and biting feints; some scens are designed to bait overreaction). Aim center mass,
  glued to one body part; edge tracking = score cheese. Undertracking (#1 tracking fault) =
  poor speed matching, the brain chases old info ("tracking a ghost behind the target"):
  cure with easier-but-FASTER scens plus the cue "track where he is GOING". Shaking while
  hitting = precision gap: slower and smaller targets, dead center. Shaky after reactive =
  play abruptly easy smoothness right after (reactive conditioning). Use the arm more.
  Late/floaty reactions = overly smooth: gradually harder reactive, awareness of changes.
- MOVEMENT: mouse and keyboard in sync; anti-mirror always (mirroring = cheese); freezing
  the crosshair (or the feet) while the other works = disconnection; move after firing
  regardless of hit.
- MEASUREMENT LIMIT: stats files cannot see the hand in tracking (invincible and regen
  bots, accuracy semantics vary per scenario). Tracking is therefore never diagnosed from
  data: the coach gives doctrine-based general assignments for tracking, no measured claims.
- REFLEX / INFORMATION / PUNISHMENT: the most game-like field; punishes misses live the way
  a game punishes with death. One single-target surprise scenario per category counters
  pre-pathing with peripherals. Requires fundamentals first.

## Difficulty calibration (scenario selection, not player judgment)

- Tracking smoothness/precision: 25-40% accuracy keeps improvement; over 50% = scenario too
  easy, under 20% = too hard. Reactive: 40-60%. Statics: 95%+ accuracy home. CALM-style
  inertia scens ("Accuracy Edit"): 60-80%, never below ~50.
- A scenario should show improvement within 3-5 runs (tracking: accuracy climbing 1-2%
  within ~10 minutes); high difficulty + frustration + zero progress = scale back or attack
  the assisting skills instead.

## Diagnostic playbook (symptom -> root -> prescription)

- Accuracy under own norm at same-or-faster pace (SPAM): assumption clicking, no
  confirmation. Prescribe confirmation methods, one accuracy-first pass on the named static
  before playing for score, punishment/one-shot statics, dead center only.
- Slower than own norm with fine accuracy (HESITATE): over-confirming; the first confirm is
  enough. Prescribe clicking earlier, one speed pass ~10% over comfort, speed statics.
- Occasional kills 3x the player's norm (CHOKES): eyes leave late for the next target, or a
  missed flick spirals into re-flicks. Prescribe eyes-first chaining; if a flick misses,
  correct forward, never re-flick from zero; low-TTK switching.
- Accuracy fades inside runs (FATIGUE): creeping grip/arm tension. Prescribe loosening the
  hand between kills, 15-30s breaks between runs, stop a death-grip run; wrist pressed into
  the desk drains tension; posture (eyes level with top of screen).
- Broadly under own norm with no specific fault (SOFT): prescribe the slowed ladder (play
  the named scenario deliberately at ~90% speed until it LOOKS clean, then normal), or the
  assisting field of that scenario (static stuck -> its pokeball/TS twin first).
- Flick lands near target then slow adjust: pokeball lines. Losing a straight-line target:
  smoothness, not reactivity. Shaky spray on the body: precision while tracking.
- Overflick in game only: target reading in dynamic (intercept where he WILL be).
- Overflicking on large targets at speed: comfort with speed lacking; large/easy scens with
  conscious push first; speed lack HIDES other faults, rule it out first.
- Score up while accuracy/technique down: regression, say it plainly.

## Progression doctrine (what to assign on a GREEN day)

Green means the habit held; comfortable is maintaining, so assign the next rung, ONE dial
at a time, small steps:
- clicking: +10% pace on the weakest static while holding the usual accuracy; or dead-center
  focus runs; or one extra-small / one-shot variant; or punishment static if confirmation
  is the current theme.
- pokeball: +5% handspeed, never a big jump; or perfect lines at current speed (zero
  over/underflick).
- tracking: same scenarios one notch faster staying smooth; or precision tightening (glue
  to one body part, no drifting inside the bot); or "track where he is GOING" as the run's
  only focus.
- switching: tighter chains (eyes first, hand 10-20% faster); or a lower-TTK / faster
  variant of the best scenario.
- General: progressive overload weekly, not daily; 2-3 pushing scenarios per ~10
  comfortable ones; variety beats repetition (three size/speed variants of one scenario,
  one minute each, beat three minutes of one).
- Speed calibration ladder: push to 100%, then back off 5% at a time until mistakes happen
  but do not form habits.

## Session context

- Rust (3+ days off): expected, not regression; technique survives breaks, cheesed score
  does not. Read the day by which habits held, prescribe an easy warmup ramp, no panic.
- Warmup: first runs of a session are cold; judge the day by the later runs.
- After a PB: celebrate in passing, then check the technique held (a PB with degraded
  accuracy is a warning, not a win).
- Plateau on a scenario: conditioning (easier/harder variants around it, SYA: same scenario
  at 75% timescale then normal), attack assisting fields, or shelve it for a week.
