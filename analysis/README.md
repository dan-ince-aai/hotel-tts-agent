# TTS preference test: analysis

Scripts that turn the session export (one CSV row per session) into the study
results. Python 3.12 with numpy, scipy and pandas (`pip install -r analysis/requirements.txt`).

## Run

```sh
python3 analysis/analyze.py export.csv                      # report to stdout
python3 analysis/analyze.py export.csv --boot 2000 --seed 7 --json results.json
python3 -m pytest analysis -q                               # tests (~15 s)
```

To try it without real data, write a simulated export first:

```sh
python3 analysis/simulate.py --write-csv /tmp/example.csv --participants 60 --gap -40
python3 analysis/analyze.py /tmp/example.csv
```

## What the report contains

1. **Data**: participants, sessions, scored sessions and setup failures by
   reason (failures are counted, never scored), and order balance (share of
   sessions with ours as call 1) per competitor.
2. **Head-to-head tallies**: ours wins / ties / competitor wins per competitor.
3. **Main outcome**: Bradley-Terry with ties (Davidson 1970) plus a call-order
   term, fit by maximum likelihood on win/tie/loss collapsed from the 5-point
   answer. Shown as Elo with ours = 1000 (`Elo = 1000 + 400/ln 10 * beta`).
   95% intervals are percentile intervals from a bootstrap over participants.
   Also reported: the call-1 advantage in Elo, the Davidson tie parameter nu
   (and the tie rate it implies for two equal systems, nu / (2 + nu)), and
   competitor-vs-competitor gaps. No session pairs two competitors, so those
   gaps rely on transitivity through ours.
4. **Person-weighted fit**: each participant's sessions weighted 1/n, so heavy
   participants cannot steer the result. Compare it with section 3.
5. **Sensitivity fits**:
   - excluding sessions flagged `ck_slow_llm`;
   - only sessions where both read-backs were correct (a missing read-back
     counts as not verified);
   - fatal TTS errors as clear losses: adds unscored sessions where exactly
     one side had a fatal TTS error, as a clear loss for that side. Scored
     sessions keep the participant's own answer.
6. **Component ratings**: mean naturalness, tone and accuracy per system,
   and paired ours-minus-competitor differences within the same session, all
   with participant-bootstrap intervals. These use every scored session that
   has the rating, even if the preference question was left blank.
7. **Reasons**: reason codes tallied by the system the participant preferred.

Every fit uses the same set of participant resamples, so you can compare their
intervals directly. If a resample has perfect separation (for example, one
system won every comparison), strengths are capped at +/-8 logits (about
+/-1390 Elo) and the report notes how many resamples hit that cap.

## Precision simulation

```sh
python3 analysis/simulate.py --participants 60 --dist even          # 1-6 sessions, evenly spread
python3 analysis/simulate.py --participants 60 --dist mostly-1-2
python3 analysis/simulate.py --participants 40 60 80 --boot 500     # also average bootstrap widths
```

This prints the expected 95% half-width (+/- Elo) of each ours-vs-competitor
gap. Default assumptions:

- 20% ties between equal systems (nu = 0.5);
- per-person taste sd of 0.5 logits;
- 5% setup failures;
- competitors rotated within each participant;
- order alternated between sessions.

With 60 participants it gives about +/-96 with sessions spread evenly over 1-6,
and about +/-132 when most people do only 1-2 sessions. That is in line with
the protocol's +/-100 and +/-127.
