#!/usr/bin/env python3
"""Analysis of the blind TTS listening test (hotel voice agent).

Each exported row is one session: two calls with the same cloned voice, one
using our TTS ("ours") and one using a competitor, in counterbalanced order,
followed by a questionnaire.

Main outcome
    Bradley-Terry with ties (Davidson 1970) plus a call-order term, fit by
    maximum likelihood on win / tie / loss collapsed from the 5-point
    preference. Strengths are put on the Elo scale with ours = 1000, and 95%
    intervals come from a bootstrap over participants.

Model (per session, call 1 system i, call 2 system j):
    a = beta_i + delta          (delta = advantage of being heard first)
    b = beta_j
    P(call 1 preferred) = e^a / D
    P(call 2 preferred) = e^b / D
    P(no preference)    = nu * e^((a + b) / 2) / D
    D = e^a + e^b + nu * e^((a + b) / 2)
beta_ours is fixed at 0; Elo = 1000 + 400 / ln(10) * beta.

Usage:
    python analysis/analyze.py export.csv [--boot 2000] [--seed N] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import minimize

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SYSTEMS = ["ours", "cartesia", "elevenlabs", "inworld"]
COMPETITORS = SYSTEMS[1:]
COMPONENTS = ["naturalness", "tone", "accuracy"]
ELO_PER_LOGIT = 400.0 / math.log(10.0)
ELO_OURS = 1000.0

# Outcomes are stored relative to call position, as the question was asked.
CALL1_PREFERRED, NO_PREFERENCE, CALL2_PREFERRED = 0, 1, 2

# Optimiser bounds. Large enough never to bind on realistic data; they only
# stop a strength running off to infinity when a (bootstrap) sample is
# perfectly separated, e.g. one system won every comparison.
BETA_BOUND = 8.0          # about +/-1390 Elo
LOG_NU_BOUNDS = (-12.0, 6.0)

REQUIRED_COLUMNS = [
    "participant_id", "session_id", "session_index", "created_at",
    "competitor", "voice", "ours_call", "preference", "reasons", "comment",
    "call1_naturalness", "call1_tone", "call1_accuracy",
    "call2_naturalness", "call2_tone", "call2_accuracy",
    "scored", "setup_failure_reason", "fatal_tts_ours", "fatal_tts_competitor",
    "ck_slow_llm", "readback_ok_ours", "readback_ok_competitor",
]

# The model only ever sees aggregated counts over 18 "cells":
# competitor (3) x which call was ours (2) x outcome (3). Each cell maps to
# the system heard in call 1, the system heard in call 2, and the outcome.
N_CELLS = len(COMPETITORS) * 2 * 3
_cell = np.arange(N_CELLS)
CELL_COMP = _cell // 6                       # 0..2 -> COMPETITORS
CELL_OURS_CALL = (_cell // 3) % 2 + 1        # 1 or 2
CELL_OUTCOME = _cell % 3                     # CALL1_PREFERRED / NO_PREFERENCE / CALL2_PREFERRED
CELL_SYS1 = np.where(CELL_OURS_CALL == 1, 0, CELL_COMP + 1)   # index into SYSTEMS
CELL_SYS2 = np.where(CELL_OURS_CALL == 1, CELL_COMP + 1, 0)

# Parameter vector layout: [beta_cartesia, beta_elevenlabs, beta_inworld, delta, log_nu]
N_PARAMS = len(COMPETITORS) + 2
I_DELTA, I_LOGNU = len(COMPETITORS), len(COMPETITORS) + 1


def cell_index(comp_idx, ours_call, outcome):
    """Cell id for (competitor index, ours_call 1/2, call-relative outcome)."""
    return comp_idx * 6 + (ours_call - 1) * 3 + outcome


# ---------------------------------------------------------------------------
# Loading and derived columns
# ---------------------------------------------------------------------------

_TRUE = {"true", "t", "1", "yes", "y"}
_FALSE = {"false", "f", "0", "no", "n"}


def _parse_bool(series: pd.Series, default=None) -> pd.Series:
    """Parse 'true'/'false' strings (any case). Empty -> default (None = NA)."""
    def conv(v):
        if isinstance(v, bool):
            return v
        s = "" if v is None or (isinstance(v, float) and math.isnan(v)) else str(v).strip().lower()
        if s in _TRUE:
            return True
        if s in _FALSE:
            return False
        return default
    out = series.map(conv)
    return out.astype("boolean") if default is None else out.astype(bool)


def _parse_int(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series.replace("", np.nan), errors="coerce").astype("Int64")


def normalize_export(raw: pd.DataFrame) -> pd.DataFrame:
    """Type the raw export columns and add derived outcome columns."""
    missing = [c for c in REQUIRED_COLUMNS if c not in raw.columns]
    if missing:
        raise ValueError(f"export is missing columns: {', '.join(missing)}")

    df = raw.copy()
    for c in ["participant_id", "session_id", "competitor", "voice", "reasons",
              "comment", "setup_failure_reason", "created_at"]:
        df[c] = df[c].fillna("").astype(str).str.strip()
    df["competitor"] = df["competitor"].str.lower()
    for c in ["session_index", "ours_call", "preference"] + [
            f"call{k}_{m}" for k in (1, 2) for m in COMPONENTS]:
        df[c] = _parse_int(df[c].astype(object).where(df[c].notna(), ""))
    for c in ["scored", "fatal_tts_ours", "fatal_tts_competitor", "ck_slow_llm"]:
        df[c] = _parse_bool(df[c], default=False)
    for c in ["readback_ok_ours", "readback_ok_competitor"]:
        df[c] = _parse_bool(df[c], default=None)

    # Rows we cannot place in the design are dropped loudly rather than guessed.
    bad = ~df["competitor"].isin(COMPETITORS) | ~df["ours_call"].isin([1, 2])
    if bad.any():
        warnings.warn(f"dropping {int(bad.sum())} row(s) with unknown competitor or ours_call")
        df = df[~bad]
    out_of_range = df["preference"].notna() & ~df["preference"].isin([-2, -1, 0, 1, 2])
    if out_of_range.any():
        warnings.warn(f"{int(out_of_range.sum())} preference value(s) outside -2..2 treated as missing")
        df.loc[out_of_range, "preference"] = pd.NA
    for k in (1, 2):
        for m in COMPONENTS:
            c = f"call{k}_{m}"
            bad_r = df[c].notna() & ~df[c].between(1, 5)
            df.loc[bad_r, c] = pd.NA

    df = df.reset_index(drop=True)
    return add_outcomes(df)


def load_export(path) -> pd.DataFrame:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False)
    return normalize_export(raw)


def add_outcomes(df: pd.DataFrame) -> pd.DataFrame:
    """Derive call-relative outcome, ours-relative result and winning system."""
    df = df.copy()
    pref = df["preference"]
    sign = np.sign(pref.astype("Float64")).astype("Int64")
    # -1 -> call 1 preferred (0), 0 -> none (1), +1 -> call 2 preferred (2)
    df["outcome"] = (sign + 1).astype("Int64")
    # Ours-relative: +1 ours preferred, 0 tie, -1 competitor preferred.
    ours_sign = np.where(df["ours_call"] == 2, 1, -1)
    df["ours_result"] = (sign * ours_sign).astype("Int64")
    winner = pd.Series(pd.NA, index=df.index, dtype=object)
    res = df["ours_result"]
    winner[(res == 1).fillna(False).to_numpy(bool)] = "ours"
    winner[(res == 0).fillna(False).to_numpy(bool)] = "no preference"
    comp_won = (res == -1).fillna(False).to_numpy(bool)
    winner[comp_won] = df.loc[comp_won, "competitor"]
    df["winner"] = winner
    return df


# ---------------------------------------------------------------------------
# Row selections (main fit and sensitivity analyses)
# ---------------------------------------------------------------------------

def select_main(df: pd.DataFrame) -> pd.DataFrame:
    """Scored sessions with a preference answer. Setup failures never enter."""
    return df[df["scored"] & df["preference"].notna()]


def select_no_slow_llm(df: pd.DataFrame) -> pd.DataFrame:
    """Sensitivity 1: drop sessions where any turn had LLM TTFT > 2400 ms."""
    m = select_main(df)
    return m[~m["ck_slow_llm"]]


def select_readback_ok(df: pd.DataFrame) -> pd.DataFrame:
    """Sensitivity 2: only sessions where both calls read back correctly."""
    m = select_main(df)
    ok = m["readback_ok_ours"].fillna(False) & m["readback_ok_competitor"].fillna(False)
    return m[ok.astype(bool)]


def select_fatal_as_loss(df: pd.DataFrame) -> pd.DataFrame:
    """Sensitivity 3: main rows plus unscored rows where exactly one side had
    a fatal TTS error, recorded as a clear loss for that side.

    Scored rows keep the answer the participant gave; unscored rows where
    both sides (or neither) had a fatal error carry no information and stay out.
    """
    main = select_main(df)
    one_side = df["fatal_tts_ours"] ^ df["fatal_tts_competitor"]
    extra = df[~df["scored"] & one_side].copy()
    if len(extra):
        # Which call position lost: ours' call if ours failed, else the other.
        ours_failed = extra["fatal_tts_ours"].to_numpy()
        ours_call = extra["ours_call"].to_numpy(dtype=int)
        loser_call = np.where(ours_failed, ours_call, 3 - ours_call)
        # Loser in call 1 -> call 2 clearly preferred (+2), and vice versa.
        extra["preference"] = pd.array(np.where(loser_call == 1, 2, -2), dtype="Int64")
        extra = add_outcomes(extra)
    return pd.concat([main, extra]) if len(extra) else main


# ---------------------------------------------------------------------------
# Bradley-Terry-Davidson with order effect
# ---------------------------------------------------------------------------

def participant_cell_counts(rows: pd.DataFrame, participants: list[str]) -> np.ndarray:
    """(n_participants, 18) matrix of session counts per participant and cell."""
    pidx = {p: i for i, p in enumerate(participants)}
    M = np.zeros((len(participants), N_CELLS))
    if len(rows) == 0:
        return M
    comp = rows["competitor"].map(COMPETITORS.index).to_numpy(dtype=int)
    cells = cell_index(comp, rows["ours_call"].to_numpy(dtype=int),
                       rows["outcome"].to_numpy(dtype=int))
    p = rows["participant_id"].map(pidx).to_numpy(dtype=int)
    np.add.at(M, (p, cells), 1.0)
    return M


def _nll_and_grad(theta: np.ndarray, n: np.ndarray):
    """Negative log-likelihood of the 18 cell counts and its gradient."""
    beta = np.concatenate([[0.0], theta[:len(COMPETITORS)]])
    delta, log_nu = theta[I_DELTA], theta[I_LOGNU]
    a = beta[CELL_SYS1] + delta
    b = beta[CELL_SYS2]
    t = log_nu + 0.5 * (a + b)
    log_d = np.logaddexp(np.logaddexp(a, b), t)
    log_p = np.choose(CELL_OUTCOME, [a, t, b]) - log_d
    nll = -np.dot(n, log_p)

    # d loglik / d a, d b, d log_nu for each cell (weighted by counts).
    p1, p2, pt = np.exp(a - log_d), np.exp(b - log_d), np.exp(t - log_d)
    o1 = (CELL_OUTCOME == CALL1_PREFERRED).astype(float)
    o2 = (CELL_OUTCOME == CALL2_PREFERRED).astype(float)
    ot = (CELL_OUTCOME == NO_PREFERENCE).astype(float)
    ga = n * (o1 + 0.5 * ot - p1 - 0.5 * pt)
    gb = n * (o2 + 0.5 * ot - p2 - 0.5 * pt)
    gt = n * (ot - pt)
    gbeta = (np.bincount(CELL_SYS1, ga, minlength=len(SYSTEMS))
             + np.bincount(CELL_SYS2, gb, minlength=len(SYSTEMS)))
    grad = np.empty(N_PARAMS)
    grad[:len(COMPETITORS)] = gbeta[1:]
    grad[I_DELTA] = ga.sum()
    grad[I_LOGNU] = gt.sum()
    return nll, -grad


_BOUNDS = [(-BETA_BOUND, BETA_BOUND)] * len(COMPETITORS) + [
    (-BETA_BOUND, BETA_BOUND), LOG_NU_BOUNDS]


def fit_bt_davidson(counts: np.ndarray, start: np.ndarray | None = None) -> np.ndarray:
    """ML fit on 18 (possibly weighted) cell counts.

    Returns the parameter vector [beta_c..., delta, log_nu]. A competitor
    with no comparisons gets beta = NaN; an empty data set gives all NaN.
    """
    counts = np.asarray(counts, dtype=float)
    if counts.sum() <= 0:
        return np.full(N_PARAMS, np.nan)
    x0 = np.zeros(N_PARAMS) if start is None else np.nan_to_num(start, nan=0.0)
    x0 = np.clip(x0, [b[0] for b in _BOUNDS], [b[1] for b in _BOUNDS])
    # Scale to per-observation units so tolerances behave the same at any n.
    scale = counts.sum()
    res = minimize(lambda th: tuple(v / scale for v in _nll_and_grad(th, counts)),
                   x0, jac=True, method="L-BFGS-B", bounds=_BOUNDS,
                   options={"maxiter": 500, "gtol": 1e-9, "ftol": 1e-13})
    theta = res.x.copy()
    present = np.bincount(CELL_COMP, counts, minlength=len(COMPETITORS)) > 0
    theta[:len(COMPETITORS)][~present] = np.nan
    return theta


def at_bound(theta: np.ndarray) -> bool:
    """True if a strength or order parameter sits on its optimiser bound."""
    core = theta[:I_LOGNU]
    return bool(np.any(np.abs(core[np.isfinite(core)]) >= BETA_BOUND - 1e-6))


def summarize_params(theta: np.ndarray) -> dict[str, np.ndarray]:
    """Turn parameter vector(s) (..., 5) into named, interpretable quantities.

    Works on a single fit or a stack of bootstrap fits (leading axis).
    """
    theta = np.asarray(theta, dtype=float)
    beta = theta[..., :len(COMPETITORS)]
    out: dict[str, np.ndarray] = {}
    for k, c in enumerate(COMPETITORS):
        out[f"elo_{c}"] = ELO_OURS + ELO_PER_LOGIT * beta[..., k]
        # Positive = ours preferred.
        out[f"gap_ours_minus_{c}"] = -ELO_PER_LOGIT * beta[..., k]
    for i in range(len(COMPETITORS)):
        for j in range(i + 1, len(COMPETITORS)):
            ci, cj = COMPETITORS[i], COMPETITORS[j]
            out[f"gap_{ci}_minus_{cj}"] = ELO_PER_LOGIT * (beta[..., i] - beta[..., j])
    out["order_elo_call1_advantage"] = ELO_PER_LOGIT * theta[..., I_DELTA]
    nu = np.exp(theta[..., I_LOGNU])
    out["nu"] = nu
    # Tie probability for two equal systems with no order effect: nu / (2 + nu).
    out["p_tie_equal"] = nu / (2.0 + nu)
    return out


def elo_to_pref_prob(gap_elo: float) -> float:
    """P(A preferred over B | someone is preferred) for an Elo gap A - B."""
    return 1.0 / (1.0 + 10.0 ** (-gap_elo / 400.0))


# ---------------------------------------------------------------------------
# Bootstrap helpers
# ---------------------------------------------------------------------------

def bootstrap_weights(n_participants: int, n_boot: int, rng: np.random.Generator) -> np.ndarray:
    """(n_boot, n_participants) multiplicity of each participant per resample."""
    if n_participants == 0:
        return np.zeros((n_boot, 0))
    idx = rng.integers(0, n_participants, size=(n_boot, n_participants))
    W = np.zeros((n_boot, n_participants))
    np.add.at(W, (np.arange(n_boot)[:, None], idx), 1.0)
    return W


def bootstrap_fits(M: np.ndarray, W: np.ndarray, start: np.ndarray) -> np.ndarray:
    """Refit the model on each participant resample. Returns (n_boot, 5)."""
    counts = W @ M
    return np.array([fit_bt_davidson(c, start) for c in counts]) if len(counts) else np.empty((0, N_PARAMS))


def percentile_ci(samples, level: float = 0.95, min_finite: int = 10):
    """Percentile interval ignoring NaN replicates; NaN if too few finite."""
    s = np.asarray(samples, dtype=float)
    s = s[np.isfinite(s)]
    if len(s) < min_finite:
        return (float("nan"), float("nan"))
    lo, hi = np.percentile(s, [50 * (1 - level), 50 * (1 + level)])
    return (float(lo), float(hi))


def _num(x):
    """JSON-friendly float (NaN/inf -> None)."""
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


# ---------------------------------------------------------------------------
# Fits with intervals
# ---------------------------------------------------------------------------

@dataclass
class FitSummary:
    label: str
    n_sessions: float
    n_participants: int
    point: dict[str, float]
    ci: dict[str, tuple[float, float]]
    boot_share_ours_ahead: dict[str, float]
    n_boot_at_bound: int
    n_boot: int
    note: str = ""

    def to_json(self):
        return {
            "label": self.label,
            "note": self.note,
            "n_sessions": _num(self.n_sessions),
            "n_participants": self.n_participants,
            "estimates": {k: {"point": _num(v), "ci95": [_num(self.ci[k][0]), _num(self.ci[k][1])]}
                          for k, v in self.point.items()},
            "boot_share_ours_ahead": {k: _num(v) for k, v in self.boot_share_ours_ahead.items()},
            "n_boot": self.n_boot,
            "n_boot_at_bound": self.n_boot_at_bound,
        }


def fit_with_intervals(label: str, M: np.ndarray, W: np.ndarray, n_sessions: float,
                       note: str = "") -> FitSummary:
    """Point fit on all rows plus participant-bootstrap percentile intervals."""
    theta = fit_bt_davidson(M.sum(axis=0))
    point = {k: float(v) for k, v in summarize_params(theta).items()}
    boot = bootstrap_fits(M, W, theta) if np.isfinite(theta[I_LOGNU]) else np.full((len(W), N_PARAMS), np.nan)
    bsum = summarize_params(boot)
    ci = {k: percentile_ci(bsum[k]) for k in point}
    share = {}
    for c in COMPETITORS:
        g = bsum[f"gap_ours_minus_{c}"]
        g = g[np.isfinite(g)]
        share[c] = float(np.mean(g > 0)) if len(g) else float("nan")
    n_bound = int(sum(at_bound(t) for t in boot))
    return FitSummary(label=label, n_sessions=n_sessions,
                      n_participants=int((M.sum(axis=1) > 0).sum()),
                      point=point, ci=ci, boot_share_ours_ahead=share,
                      n_boot_at_bound=n_bound, n_boot=len(W), note=note)


# ---------------------------------------------------------------------------
# Component ratings
# ---------------------------------------------------------------------------

def _ratings_for(rows: pd.DataFrame, side: str, comp: str) -> pd.Series:
    """Rating of `comp` for the ours/competitor call of each row."""
    ours_call = rows["ours_call"].to_numpy(dtype=int)
    call = ours_call if side == "ours" else 3 - ours_call
    c1 = rows[f"call1_{comp}"].astype("Float64")
    c2 = rows[f"call2_{comp}"].astype("Float64")
    return pd.Series(np.where(call == 1, c1.to_numpy(dtype=float, na_value=np.nan),
                              c2.to_numpy(dtype=float, na_value=np.nan)), index=rows.index)


def component_analysis(df: pd.DataFrame, participants: list[str], W: np.ndarray) -> dict:
    """Mean 1-5 ratings per system and paired ours-minus-competitor differences.

    Uses all scored sessions (a missing preference does not discard ratings).
    Means are session-weighted ratio estimates; intervals resample participants.
    """
    rows = df[df["scored"]]
    pidx = rows["participant_id"].map({p: i for i, p in enumerate(participants)}).to_numpy(dtype=int)
    P = len(participants)

    def ratio_stat(values: np.ndarray, mask: np.ndarray):
        """Per-participant sums/counts -> point mean, CI, n."""
        S = np.bincount(pidx[mask], values[mask], minlength=P)
        N = np.bincount(pidx[mask], minlength=P).astype(float)
        n = N.sum()
        point = S.sum() / n if n else float("nan")
        with np.errstate(invalid="ignore", divide="ignore"):
            boot = (W @ S) / (W @ N)
        return {"mean": _num(point), "ci95": [_num(v) for v in percentile_ci(boot)], "n": int(n)}

    means: dict[str, dict] = {}
    for system in SYSTEMS:
        means[system] = {}
        for comp in COMPONENTS:
            if system == "ours":
                vals = _ratings_for(rows, "ours", comp).to_numpy()
                mask = np.isfinite(vals)
            else:
                vals = _ratings_for(rows, "competitor", comp).to_numpy()
                mask = np.isfinite(vals) & (rows["competitor"] == system).to_numpy()
            means[system][comp] = ratio_stat(np.nan_to_num(vals), mask)

    paired: dict[str, dict] = {}
    for target in COMPETITORS + ["all competitors"]:
        paired[target] = {}
        in_target = np.ones(len(rows), bool) if target == "all competitors" else (rows["competitor"] == target).to_numpy()
        for comp in COMPONENTS:
            d = (_ratings_for(rows, "ours", comp) - _ratings_for(rows, "competitor", comp)).to_numpy()
            mask = np.isfinite(d) & in_target
            paired[target][comp] = ratio_stat(np.nan_to_num(d), mask)
    return {"means": means, "paired_ours_minus_competitor": paired}


# ---------------------------------------------------------------------------
# Descriptive counts
# ---------------------------------------------------------------------------

def descriptive_counts(df: pd.DataFrame) -> dict:
    main = select_main(df)
    failures = df[~df["scored"]]
    reasons = failures["setup_failure_reason"].replace("", "(unspecified)").value_counts()

    order = {}
    for c in COMPETITORS:
        a = df[df["competitor"] == c]
        m = main[main["competitor"] == c]
        order[c] = {
            "all_sessions": int(len(a)), "all_ours_first": int((a["ours_call"] == 1).sum()),
            "main_sessions": int(len(m)), "main_ours_first": int((m["ours_call"] == 1).sum()),
        }

    tallies = {}
    for c in COMPETITORS:
        m = main[main["competitor"] == c]
        r = m["ours_result"]
        # Mean 5-point answer re-signed so +2 = ours clearly preferred.
        toward_ours = (m["preference"].astype(float) * np.where(m["ours_call"] == 2, 1, -1))
        tallies[c] = {
            "n": int(len(m)), "ours_wins": int((r == 1).sum()), "ties": int((r == 0).sum()),
            "competitor_wins": int((r == -1).sum()),
            "ours_clear_wins": int((toward_ours == 2).sum()),
            "competitor_clear_wins": int((toward_ours == -2).sum()),
            "mean_pref_toward_ours": _num(toward_ours.mean()) if len(m) else None,
        }

    # Reason codes tallied by the system the participant preferred.
    reason_tally: dict[str, dict] = {}
    for winner in ["ours"] + COMPETITORS + ["no preference"]:
        w = main[main["winner"] == winner]
        codes: dict[str, int] = {}
        for s in w["reasons"]:
            for code in (x.strip().lower() for x in s.split(";")):
                if code:
                    codes[code] = codes.get(code, 0) + 1
        reason_tally[winner] = {"sessions": int(len(w)),
                                "codes": dict(sorted(codes.items(), key=lambda kv: (-kv[1], kv[0])))}

    return {
        "participants": int(df["participant_id"].nunique()),
        "sessions": int(len(df)),
        "scored": int(df["scored"].sum()),
        "setup_failures": int(len(failures)),
        "setup_failures_by_reason": {str(k): int(v) for k, v in reasons.items()},
        "scored_without_preference": int((df["scored"] & df["preference"].isna()).sum()),
        "main_fit_sessions": int(len(main)),
        "main_fit_participants": int(main["participant_id"].nunique()),
        "sessions_per_participant": {str(k): int(v) for k, v in
                                     main.groupby("participant_id").size().value_counts().sort_index().items()},
        "order_balance": order,
        "head_to_head": tallies,
        "reasons_by_winner": reason_tally,
        "slow_llm_sessions": int(main["ck_slow_llm"].sum()),
        "fatal_tts_unscored_one_side": int((~df["scored"] & (df["fatal_tts_ours"] ^ df["fatal_tts_competitor"])).sum()),
    }


# ---------------------------------------------------------------------------
# Full analysis
# ---------------------------------------------------------------------------

def run_analysis(df: pd.DataFrame, n_boot: int = 2000, seed: int = 20261023) -> dict:
    participants = sorted(df["participant_id"].unique().tolist())
    rng = np.random.default_rng(seed)
    # One set of participant resamples is shared by every fit, so the intervals
    # of the main, person-weighted and sensitivity fits are directly comparable.
    W = bootstrap_weights(len(participants), n_boot, rng)

    main_rows = select_main(df)
    M_main = participant_cell_counts(main_rows, participants)
    main = fit_with_intervals("main", M_main, W, len(main_rows))

    # Person-weighted: each participant's sessions weighted 1/n so every
    # participant contributes a total weight of one.
    per_person = M_main.sum(axis=1, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        M_pw = np.where(per_person > 0, M_main / per_person, 0.0)
    person_weighted = fit_with_intervals(
        "person-weighted", M_pw, W, float(M_pw.sum()),
        note="each participant weighted 1/n_sessions; n_sessions here is the total weight (= participants)")

    sens_specs = [
        ("excluding slow-LLM sessions", select_no_slow_llm,
         "drops sessions where any turn had LLM time-to-first-token > 2400 ms"),
        ("both read-backs correct", select_readback_ok,
         "only sessions where name, nights and address were read back correctly on both calls"),
        ("fatal TTS errors as clear losses", select_fatal_as_loss,
         "adds unscored sessions where exactly one side had a fatal TTS error, as a clear loss for that side"),
    ]
    sensitivity = []
    for label, selector, note in sens_specs:
        rows = selector(df)
        sensitivity.append(fit_with_intervals(label, participant_cell_counts(rows, participants),
                                              W, len(rows), note=note))

    return {
        "settings": {"n_boot": n_boot, "seed": seed, "elo_reference": {"ours": ELO_OURS},
                     "elo_per_logit": ELO_PER_LOGIT},
        "counts": descriptive_counts(df),
        "main": main,
        "person_weighted": person_weighted,
        "sensitivity": sensitivity,
        "components": component_analysis(df, participants, W),
    }


def result_to_json(result: dict) -> dict:
    out = dict(result)
    out["main"] = result["main"].to_json()
    out["person_weighted"] = result["person_weighted"].to_json()
    out["sensitivity"] = [s.to_json() for s in result["sensitivity"]]
    out["notes"] = {
        "competitor_gaps": "Competitor-vs-competitor gaps are indirect: no session pairs two "
                           "competitors, so they rely on transitivity through ours.",
        "order": "order_elo_call1_advantage > 0 means the first call is favoured.",
        "ties": "nu is the Davidson tie parameter; p_tie_equal = nu / (2 + nu).",
    }
    return out


# ---------------------------------------------------------------------------
# Plain-text report
# ---------------------------------------------------------------------------

def _fmt(v, signed=True, digits=0):
    if v is None or not math.isfinite(v):
        return "n/a"
    s = f"{v:+.{digits}f}" if signed else f"{v:.{digits}f}"
    return s


def _fmt_ci(ci, signed=True, digits=0):
    lo, hi = ci
    if not (math.isfinite(lo) and math.isfinite(hi)):
        return "[n/a]"
    return f"[{_fmt(lo, signed, digits)}, {_fmt(hi, signed, digits)}]"


def _pct(a, b):
    return f"{a}/{b} ({100 * a / b:.0f}%)" if b else f"{a}/0"


def _gap_lines(fit: FitSummary, indent="  ") -> list[str]:
    lines = [f"{indent}{'vs competitor':<14}{'ours - comp':>12}  {'95% CI':<16}{'+/-':>6}"
             f"  {'P(ours pref.)':>13}  {'boot ours>comp':>14}"]
    for c in COMPETITORS:
        k = f"gap_ours_minus_{c}"
        g, ci = fit.point[k], fit.ci[k]
        half = (ci[1] - ci[0]) / 2 if all(map(math.isfinite, ci)) else float("nan")
        p = elo_to_pref_prob(g) if math.isfinite(g) else float("nan")
        lines.append(f"{indent}{c:<14}{_fmt(g):>12}  {_fmt_ci(ci):<16}{_fmt(half, False):>6}"
                     f"  {_fmt(100 * p, False):>12}%  {_fmt(100 * fit.boot_share_ours_ahead[c], False):>13}%")
    return lines


def format_report(result: dict, source: str = "") -> str:
    c = result["counts"]
    main: FitSummary = result["main"]
    L: list[str] = []
    add = L.append

    add("TTS blind preference test - analysis")
    add("=" * 72)
    if source:
        add(f"Input: {source}")
    add(f"Bootstrap: {result['settings']['n_boot']} resamples of participants "
        f"(seed {result['settings']['seed']}); intervals are 95% percentile intervals.")
    add("")

    # 1. Data
    add("1. Data")
    add(f"  Participants: {c['participants']}    Sessions: {c['sessions']}")
    add(f"  Scored: {c['scored']}    Setup failures (counted, not scored): {c['setup_failures']}")
    for reason, n in c["setup_failures_by_reason"].items():
        add(f"    {reason:<40}{n:>5}")
    add(f"  Scored but no preference answer: {c['scored_without_preference']}")
    add(f"  Sessions in main fit: {c['main_fit_sessions']} from {c['main_fit_participants']} participants")
    spp = ", ".join(f"{k}: {v}" for k, v in c["sessions_per_participant"].items())
    add(f"  Participants by number of scored sessions: {spp or 'n/a'}")
    add("")
    add("  Order balance (sessions with ours as call 1)")
    add(f"    {'competitor':<14}{'all sessions':>18}{'main fit':>18}")
    for comp, o in c["order_balance"].items():
        add(f"    {comp:<14}{_pct(o['all_ours_first'], o['all_sessions']):>18}"
            f"{_pct(o['main_ours_first'], o['main_sessions']):>18}")
    add("")

    # 2. Raw tallies
    add("2. Head-to-head tallies (main fit sessions)")
    add(f"    {'competitor':<14}{'n':>5}{'ours wins':>11}{'ties':>7}{'comp wins':>11}"
        f"{'clear o/c':>11}{'mean pref':>11}")
    for comp, t in c["head_to_head"].items():
        add(f"    {comp:<14}{t['n']:>5}{t['ours_wins']:>11}{t['ties']:>7}{t['competitor_wins']:>11}"
            f"{str(t['ours_clear_wins']) + '/' + str(t['competitor_clear_wins']):>11}"
            f"{_fmt(t['mean_pref_toward_ours'], True, 2):>11}")
    add("    (mean pref on -2..+2, re-signed so + favours ours; 'clear o/c' = clear wins ours/competitor)")
    add("")

    # 3. Main fit
    add("3. Main outcome: Bradley-Terry-Davidson with call-order term (Elo, ours = 1000)")
    add(f"  Sessions: {main.n_sessions:.0f}    Participants: {main.n_participants}")
    add(f"    {'system':<14}{'Elo':>7}  95% CI")
    add(f"    {'ours':<14}{1000:>7}  (reference)")
    for comp in COMPETITORS:
        k = f"elo_{comp}"
        add(f"    {comp:<14}{_fmt(main.point[k], False):>7}  {_fmt_ci(main.ci[k], False)}")
    add("")
    add("  Ours minus competitor (positive = ours preferred):")
    L.extend(_gap_lines(main, "    "))
    add("    P(ours pref.) = implied chance ours is preferred when someone is preferred.")
    add("")
    k = "order_elo_call1_advantage"
    add(f"  Call-order effect: call 1 advantage {_fmt(main.point[k])} Elo {_fmt_ci(main.ci[k])}"
        "  (positive = first call favoured)")
    add(f"  Ties: Davidson nu = {_fmt(main.point['nu'], False, 3)} {_fmt_ci(main.ci['nu'], False, 3)};"
        f" implied P(no preference) between equal systems = "
        f"{_fmt(100 * main.point['p_tie_equal'], False, 1)}%")
    add("")
    add("  Competitor vs competitor (indirect: relies on transitivity - no session")
    add("  pairs two competitors, so these gaps run through ours):")
    for i in range(len(COMPETITORS)):
        for j in range(i + 1, len(COMPETITORS)):
            k = f"gap_{COMPETITORS[i]}_minus_{COMPETITORS[j]}"
            add(f"    {COMPETITORS[i] + ' - ' + COMPETITORS[j]:<26}{_fmt(main.point[k]):>7}  {_fmt_ci(main.ci[k])}")
    if main.n_boot_at_bound:
        add(f"  Note: {main.n_boot_at_bound} bootstrap fit(s) hit a parameter bound "
            "(perfect separation in a resample); intervals may be wide on that side.")
    add("")

    # 4. Person-weighted
    pw: FitSummary = result["person_weighted"]
    add("4. Person-weighted check (each participant weighted 1/n_sessions)")
    L.extend(_gap_lines(pw, "    "))
    add(f"    Call-order effect {_fmt(pw.point[k])} Elo {_fmt_ci(pw.ci[k])};"
        f" nu = {_fmt(pw.point['nu'], False, 3)}")
    add("    Compare with section 3: a large shift means a few heavy participants steer the result.")
    add("")

    # 5. Sensitivity
    add("5. Sensitivity fits (ours minus competitor, Elo [95% CI])")
    header = f"    {'fit':<34}{'n':>5}" + "".join(f"{comp:>21}" for comp in COMPETITORS)
    add(header)
    for fit in [main] + result["sensitivity"]:
        row = f"    {fit.label:<34}{fit.n_sessions:>5.0f}"
        for comp in COMPETITORS:
            kk = f"gap_ours_minus_{comp}"
            cell = f"{_fmt(fit.point[kk])} {_fmt_ci(fit.ci[kk])}"
            row += f"{cell:>21}"
        add(row)
    for fit in result["sensitivity"]:
        add(f"    - {fit.label}: {fit.note}")
    add("")

    # 6. Components
    comps = result["components"]
    add("6. Component ratings (1-5; mean [95% CI], n)")
    for system in SYSTEMS:
        cells = []
        for comp in COMPONENTS:
            s = comps["means"][system][comp]
            cells.append(f"{comp} {_fmt(s['mean'], False, 2)} "
                         f"{_fmt_ci([x if x is not None else float('nan') for x in s['ci95']], False, 2)} n={s['n']}")
        add(f"    {system:<12}" + "; ".join(cells))
    add("  Paired ours minus competitor, same session (positive = ours rated higher):")
    for target, d in comps["paired_ours_minus_competitor"].items():
        cells = []
        for comp in COMPONENTS:
            s = d[comp]
            cells.append(f"{comp} {_fmt(s['mean'], True, 2)} "
                         f"{_fmt_ci([x if x is not None else float('nan') for x in s['ci95']], True, 2)}")
        n = d[COMPONENTS[0]]["n"]
        add(f"    {target:<16}" + "; ".join(cells) + f"  (n={n})")
    add("")

    # 7. Reasons
    add("7. Reasons given, by preferred system (main fit sessions)")
    for winner, r in c["reasons_by_winner"].items():
        codes = ", ".join(f"{k} {v}" for k, v in r["codes"].items()) or "-"
        add(f"    {winner:<14}{r['sessions']:>4} sessions   {codes}")
    add("")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("export", help="session export CSV")
    ap.add_argument("--boot", type=int, default=2000, help="bootstrap resamples (default 2000)")
    ap.add_argument("--seed", type=int, default=20261023, help="bootstrap RNG seed")
    ap.add_argument("--json", metavar="PATH", help="also write machine-readable results here")
    args = ap.parse_args(argv)

    df = load_export(args.export)
    if len(df) == 0:
        print("export has no usable rows", file=sys.stderr)
        return 1
    result = run_analysis(df, n_boot=args.boot, seed=args.seed)
    print(format_report(result, source=args.export))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(result_to_json(result), f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
