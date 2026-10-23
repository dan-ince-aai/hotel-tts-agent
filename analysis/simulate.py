#!/usr/bin/env python3
"""Simulated exports and a precision simulation for the TTS preference test.

Two uses:

1. `simulate_export(...)` generates a data set in exactly the export format
   from known Elo gaps, a known call-order effect and a known tie parameter.
   The tests use it to check that analyze.py recovers what went in.

2. The CLI estimates the expected 95% half-width (+/- Elo) of each
   ours-vs-competitor gap for a given number of participants and
   sessions-per-person distribution:

       python analysis/simulate.py --participants 60 --dist even
       python analysis/simulate.py --participants 60 --dist mostly-1-2
       python analysis/simulate.py --participants 60 --dist 0.5,0.3,0.1,0.05,0.03,0.02
       python analysis/simulate.py --write-csv example.csv   # a fake export to try analyze.py on

Design assumptions (match the study protocol as described):
  - each participant's sessions rotate through the three competitors in a
    random order, so 3 sessions cover each competitor once;
  - ours plays call 1 in alternate sessions, starting position random;
  - ties follow the Davidson model with parameter nu;
  - optional participant heterogeneity: a per-person shift (sd, logits) in
    how much they like ours, which is what makes a participant bootstrap wider
    than a naive per-session interval.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Import the analysis module from this directory even under `python -I`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as az  # noqa: E402

SETUP_FAILURE_REASONS = ["call_never_connected", "never_spoke", "skipped_failing", "only_dropped"]
REASON_CODES = ["human", "tone", "accuracy", "speed", "other"]
VOICES = ["jane", "shirley", "eli", "charles"]

DISTRIBUTIONS = {
    # sessions-per-participant probabilities for 1..6 sessions
    "even": [1 / 6] * 6,
    "mostly-1-2": [0.45, 0.35, 0.08, 0.05, 0.04, 0.03],
}


def _b(x: bool) -> str:
    return "true" if x else "false"


def simulate_export(
    n_participants: int,
    sessions_probs=DISTRIBUTIONS["even"],
    elo_gaps: dict[str, float] | None = None,
    order_elo: float = 0.0,
    nu: float = 0.5,
    participant_sd: float = 0.0,
    setup_failure_rate: float = 0.0,
    fatal_share_of_failures: float = 0.5,
    slow_llm_rate: float = 0.0,
    readback_fail_rate: float = 0.0,
    seed: int | None = None,
) -> pd.DataFrame:
    """Simulate an export (all columns as strings, like the server's CSV).

    elo_gaps: competitor Elo minus ours (e.g. {"cartesia": -50}); default all 0.
    order_elo: advantage of being call 1, in Elo.
    """
    rng = np.random.default_rng(seed)
    elo_gaps = {c: 0.0 for c in az.COMPETITORS} | (elo_gaps or {})
    beta = {"ours": 0.0} | {c: elo_gaps[c] / az.ELO_PER_LOGIT for c in az.COMPETITORS}
    delta = order_elo / az.ELO_PER_LOGIT
    probs = np.asarray(sessions_probs, float)
    probs = probs / probs.sum()

    rows = []
    for p in range(n_participants):
        pid = f"p{p:04d}"
        n_sess = int(rng.choice(np.arange(1, len(probs) + 1), p=probs))
        u = rng.normal(0.0, participant_sd) if participant_sd > 0 else 0.0
        first_ours_call = int(rng.integers(1, 3))
        voice = str(rng.choice(VOICES))
        for s in range(n_sess):
            if s % 3 == 0:  # fresh random rotation for sessions 1-3 and 4-6
                comps = list(rng.permutation(az.COMPETITORS))
            comp = str(comps[s % 3])
            ours_call = first_ours_call if s % 2 == 0 else 3 - first_ours_call
            sys1, sys2 = ("ours", comp) if ours_call == 1 else (comp, "ours")
            strength = {"ours": beta["ours"] + u, comp: beta[comp]}
            a, b = strength[sys1] + delta, strength[sys2]
            w = np.array([np.exp(a), nu * np.exp((a + b) / 2), np.exp(b)])
            outcome = int(rng.choice(3, p=w / w.sum()))  # 0 call1, 1 tie, 2 call2
            clear = rng.random() < 0.5
            pref = [-1, 0, 1][outcome] * (2 if clear else 1)

            failed = rng.random() < setup_failure_rate
            row = {
                "participant_id": pid, "session_id": f"{pid}-s{s + 1}", "session_index": s + 1,
                "created_at": f"2026-11-{1 + (p % 28):02d}T12:{s:02d}:00Z",
                "competitor": comp, "voice": voice, "ours_call": ours_call,
                "scored": _b(not failed), "setup_failure_reason": "",
                "fatal_tts_ours": "false", "fatal_tts_competitor": "false",
                "ck_slow_llm": _b(rng.random() < slow_llm_rate),
                "comment": "",
            }
            if failed:
                row |= {"preference": "", "reasons": "",
                        "setup_failure_reason": str(rng.choice(SETUP_FAILURE_REASONS)),
                        "readback_ok_ours": "", "readback_ok_competitor": ""}
                if rng.random() < fatal_share_of_failures:
                    side = "ours" if rng.random() < 0.5 else "competitor"
                    row[f"fatal_tts_{side}"] = "true"
                for k in (1, 2):
                    for m in az.COMPONENTS:
                        row[f"call{k}_{m}"] = ""
            else:
                n_reasons = int(rng.integers(0, 3))
                row |= {
                    "preference": pref,
                    "reasons": ";".join(rng.choice(REASON_CODES, size=n_reasons, replace=False)),
                    "readback_ok_ours": _b(rng.random() >= readback_fail_rate),
                    "readback_ok_competitor": _b(rng.random() >= readback_fail_rate),
                }
                # Ratings: latent quality on the logit scale plus noise.
                for k, system in ((1, sys1), (2, sys2)):
                    for j, m in enumerate(az.COMPONENTS):
                        r = 3.4 + 0.1 * j + 0.8 * strength[system] + rng.normal(0, 0.9)
                        row[f"call{k}_{m}"] = int(np.clip(np.rint(r), 1, 5))
            rows.append(row)

    df = pd.DataFrame(rows)[az.REQUIRED_COLUMNS]
    return df.astype(str).replace({"nan": "", "<NA>": ""})


def precision(n_participants: int, sessions_probs, reps: int = 400, n_boot: int = 0,
              boot_reps: int = 40, seed: int = 1, **sim_kwargs) -> dict:
    """Expected 95% half-width of each ours-minus-competitor gap (Elo).

    `spread` = 1.96 x sd of the point estimate across simulated studies
    (what a well-calibrated interval should be). With n_boot > 0 it also
    averages the participant-bootstrap half-width that analyze.py would report
    over `boot_reps` simulated studies.
    """
    rng = np.random.default_rng(seed)
    gaps, sessions = [], []
    boot_half = []
    for r in range(reps):
        df = az.normalize_export(simulate_export(n_participants, sessions_probs,
                                                 seed=int(rng.integers(2**31)), **sim_kwargs))
        main = az.select_main(df)
        participants = sorted(df["participant_id"].unique())
        M = az.participant_cell_counts(main, participants)
        theta = az.fit_bt_davidson(M.sum(axis=0))
        s = az.summarize_params(theta)
        gaps.append([s[f"gap_ours_minus_{c}"] for c in az.COMPETITORS])
        sessions.append(len(main))
        if n_boot and r < boot_reps:
            W = az.bootstrap_weights(len(participants), n_boot, rng)
            bs = az.summarize_params(az.bootstrap_fits(M, W, theta))
            boot_half.append([np.diff(az.percentile_ci(bs[f"gap_ours_minus_{c}"]))[0] / 2
                              for c in az.COMPETITORS])
    gaps = np.asarray(gaps, float)
    out = {
        "participants": n_participants,
        "mean_scored_sessions": float(np.mean(sessions)),
        "reps": reps,
        "half_width_spread": {c: float(1.96 * np.nanstd(gaps[:, k], ddof=1))
                              for k, c in enumerate(az.COMPETITORS)},
        "half_width_percentile": {c: float(np.diff(np.nanpercentile(gaps[:, k], [2.5, 97.5]))[0] / 2)
                                  for k, c in enumerate(az.COMPETITORS)},
        "mean_estimate": {c: float(np.nanmean(gaps[:, k])) for k, c in enumerate(az.COMPETITORS)},
    }
    if boot_half:
        bh = np.asarray(boot_half, float)
        out["half_width_bootstrap"] = {c: float(np.nanmean(bh[:, k])) for k, c in enumerate(az.COMPETITORS)}
    return out


def _parse_dist(s: str):
    if s in DISTRIBUTIONS:
        return DISTRIBUTIONS[s]
    vals = [float(x) for x in s.split(",")]
    if len(vals) != 6 or min(vals) < 0 or sum(vals) <= 0:
        raise argparse.ArgumentTypeError("--dist needs a preset or six non-negative weights for 1..6 sessions")
    return vals


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Precision simulation for the TTS preference test")
    ap.add_argument("--participants", type=int, nargs="+", default=[60])
    ap.add_argument("--dist", type=_parse_dist, default=DISTRIBUTIONS["even"],
                    help="'even', 'mostly-1-2', or six comma-separated weights for 1..6 sessions")
    ap.add_argument("--reps", type=int, default=400, help="simulated studies per setting")
    ap.add_argument("--boot", type=int, default=0, help="also average bootstrap half-widths (resamples)")
    ap.add_argument("--boot-reps", type=int, default=40, help="studies to bootstrap when --boot > 0")
    ap.add_argument("--nu", type=float, default=0.5, help="Davidson tie parameter (0.5 = 20%% ties when equal)")
    ap.add_argument("--participant-sd", type=float, default=0.5,
                    help="sd (logits) of per-person liking for ours")
    ap.add_argument("--gap", type=float, default=0.0, help="true competitor-minus-ours Elo gap (all competitors)")
    ap.add_argument("--order-elo", type=float, default=0.0, help="true call-1 advantage (Elo)")
    ap.add_argument("--failure-rate", type=float, default=0.05, help="share of sessions that are setup failures")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--write-csv", metavar="PATH", help="write one simulated export and exit")
    args = ap.parse_args(argv)

    sim = dict(elo_gaps={c: args.gap for c in az.COMPETITORS}, order_elo=args.order_elo, nu=args.nu,
               participant_sd=args.participant_sd, setup_failure_rate=args.failure_rate)
    if args.write_csv:
        simulate_export(args.participants[0], args.dist, seed=args.seed, slow_llm_rate=0.1,
                        readback_fail_rate=0.1, **sim).to_csv(args.write_csv, index=False)
        print(f"wrote {args.write_csv}")
        return 0

    probs = np.asarray(args.dist) / np.sum(args.dist)
    mean_sess = float(np.dot(probs, np.arange(1, 7)))
    print(f"Sessions per participant: P(1..6) = {', '.join(f'{p:.2f}' for p in probs)} (mean {mean_sess:.2f})")
    print(f"Assumed: nu={args.nu} (ties {100 * args.nu / (2 + args.nu):.0f}% when equal), "
          f"participant sd={args.participant_sd} logits, true gap={args.gap:+.0f} Elo, "
          f"order={args.order_elo:+.0f} Elo, setup failures={100 * args.failure_rate:.0f}%")
    print(f"95% half-width of ours-minus-competitor gap (Elo), {args.reps} simulated studies each:")
    for n in args.participants:
        r = precision(n, args.dist, reps=args.reps, n_boot=args.boot, boot_reps=args.boot_reps,
                      seed=args.seed, **sim)
        hw = np.mean(list(r["half_width_spread"].values()))
        line = (f"  N={n:>4}  scored sessions ~{r['mean_scored_sessions']:.0f}  "
                f"+/-{hw:.0f} (" + ", ".join(f"{c} {v:.0f}" for c, v in r["half_width_spread"].items()) + ")")
        if "half_width_bootstrap" in r:
            line += f"  bootstrap +/-{np.mean(list(r['half_width_bootstrap'].values())):.0f}"
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
