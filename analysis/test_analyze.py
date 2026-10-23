"""Tests for analyze.py: recovery from simulated data, ties, bootstrap coverage,
sensitivity filters and setup-failure handling.

Run from the project root:  python3 -m pytest analysis -q
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as az  # noqa: E402
import simulate as sim  # noqa: E402

# Ground truth used by the recovery tests (competitor Elo minus ours).
TRUE_GAPS = {"cartesia": -80.0, "elevenlabs": 40.0, "inworld": -150.0}
TRUE_ORDER_ELO = 45.0   # call 1 advantage
TRUE_NU = 0.4


def main_fit(df):
    """Point fit of the main model on a normalised export."""
    participants = sorted(df["participant_id"].unique())
    M = az.participant_cell_counts(az.select_main(df), participants)
    return az.summarize_params(az.fit_bt_davidson(M.sum(axis=0)))


@pytest.fixture(scope="module")
def big_sim():
    """A large simulated study (~14k sessions) so the MLE sits close to truth."""
    raw = sim.simulate_export(4000, elo_gaps=TRUE_GAPS, order_elo=TRUE_ORDER_ELO, nu=TRUE_NU,
                              setup_failure_rate=0.05, seed=11)
    return az.normalize_export(raw)


# ---------------------------------------------------------------------------
# Model recovery
# ---------------------------------------------------------------------------

def test_recovers_elo_gaps_and_order_effect(big_sim):
    s = main_fit(big_sim)
    for c, gap in TRUE_GAPS.items():
        assert s[f"elo_{c}"] == pytest.approx(1000 + gap, abs=25), c
        assert s[f"gap_ours_minus_{c}"] == pytest.approx(-gap, abs=25), c
    # Competitor-vs-competitor gaps follow by transitivity.
    assert s["gap_cartesia_minus_inworld"] == pytest.approx(
        TRUE_GAPS["cartesia"] - TRUE_GAPS["inworld"], abs=30)
    assert s["order_elo_call1_advantage"] == pytest.approx(TRUE_ORDER_ELO, abs=15)


def test_recovers_tie_parameter(big_sim):
    s = main_fit(big_sim)
    assert s["nu"] == pytest.approx(TRUE_NU, rel=0.12)
    assert s["p_tie_equal"] == pytest.approx(TRUE_NU / (2 + TRUE_NU), abs=0.02)


@pytest.mark.parametrize("nu", [0.05, 1.0, 3.0])
def test_tie_parameter_tracks_tie_rate(nu):
    df = az.normalize_export(sim.simulate_export(2000, nu=nu, seed=3))
    assert main_fit(df)["nu"] == pytest.approx(nu, rel=0.2)


def test_no_ties_drives_nu_to_zero():
    df = az.normalize_export(sim.simulate_export(500, nu=1e-9, seed=4))
    assert (az.select_main(df)["preference"] != 0).all()
    s = main_fit(df)
    assert s["nu"] < 1e-3
    assert math.isfinite(s["gap_ours_minus_cartesia"])


def test_order_effect_sign_and_counterbalance():
    """A pure position effect must not leak into system strengths."""
    df = az.normalize_export(sim.simulate_export(3000, order_elo=-120, seed=5))
    s = main_fit(df)
    assert s["order_elo_call1_advantage"] == pytest.approx(-120, abs=20)
    for c in az.COMPETITORS:
        assert abs(s[f"gap_ours_minus_{c}"]) < 25


def test_elo_scale():
    theta = np.array([math.log(10) / 400 * 100, 0.0, -math.log(10) / 400 * 50, 0.0, 0.0])
    s = az.summarize_params(theta)
    assert s["elo_cartesia"] == pytest.approx(1100)
    assert s["elo_elevenlabs"] == pytest.approx(1000)
    assert s["gap_ours_minus_inworld"] == pytest.approx(50)
    assert s["gap_cartesia_minus_inworld"] == pytest.approx(150)
    assert s["nu"] == pytest.approx(1.0) and s["p_tie_equal"] == pytest.approx(1 / 3)


def test_outcome_mapping_relative_to_ours_call():
    rows = [
        # ours_call, preference -> expected ours_result, outcome
        (1, -2, 1, 0), (1, -1, 1, 0), (1, 0, 0, 1), (1, 1, -1, 2), (1, 2, -1, 2),
        (2, -2, -1, 0), (2, 0, 0, 1), (2, 1, 1, 2), (2, 2, 1, 2),
    ]
    df = make_rows([dict(ours_call=oc, preference=p) for oc, p, _, _ in rows])
    assert df["ours_result"].tolist() == [r for _, _, r, _ in rows]
    assert df["outcome"].tolist() == [o for _, _, _, o in rows]


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

def test_bootstrap_intervals_cover_truth():
    """Participant-bootstrap 95% intervals should cover the truth ~95% of the
    time, including with per-person heterogeneity (clustered sessions)."""
    rng = np.random.default_rng(7)
    hits, total = 0, 0
    order_hits = 0
    n_studies = 40
    for _ in range(n_studies):
        df = az.normalize_export(sim.simulate_export(
            80, elo_gaps=TRUE_GAPS, order_elo=TRUE_ORDER_ELO, nu=TRUE_NU,
            participant_sd=0.4, seed=int(rng.integers(2**31))))
        participants = sorted(df["participant_id"].unique())
        M = az.participant_cell_counts(az.select_main(df), participants)
        W = az.bootstrap_weights(len(participants), 200, rng)
        fit = az.fit_with_intervals("t", M, W, M.sum())
        for c, gap in TRUE_GAPS.items():
            lo, hi = fit.ci[f"gap_ours_minus_{c}"]
            hits += lo <= -gap <= hi
            total += 1
        lo, hi = fit.ci["order_elo_call1_advantage"]
        order_hits += lo <= TRUE_ORDER_ELO <= hi
    assert 0.85 <= hits / total <= 1.0
    assert order_hits / n_studies >= 0.8


def test_bootstrap_weights_resample_participants():
    W = az.bootstrap_weights(30, 100, np.random.default_rng(0))
    assert W.shape == (100, 30)
    assert (W.sum(axis=1) == 30).all()        # each resample has n participants
    assert (W == 0).any(axis=1).mean() > 0.9  # with replacement: some left out


def test_run_analysis_intervals_bracket_points():
    df = az.normalize_export(sim.simulate_export(60, elo_gaps=TRUE_GAPS, seed=8,
                                                 setup_failure_rate=0.1, slow_llm_rate=0.2,
                                                 readback_fail_rate=0.2))
    res = az.run_analysis(df, n_boot=200, seed=1)
    for fit in [res["main"], res["person_weighted"], *res["sensitivity"]]:
        for c in az.COMPETITORS:
            k = f"gap_ours_minus_{c}"
            lo, hi = fit.ci[k]
            assert lo <= fit.point[k] <= hi, (fit.label, k)
    # Competitor-vs-competitor gaps have their own intervals.
    assert all(math.isfinite(v) for v in res["main"].ci["gap_cartesia_minus_elevenlabs"])


def test_person_weighting_is_neutral_when_everyone_has_same_n():
    """With equal sessions per person the 1/n weights are a constant, which
    must not change the maximum-likelihood estimate."""
    df = az.normalize_export(sim.simulate_export(200, sessions_probs=[0, 0, 1, 0, 0, 0], seed=9))
    res = az.run_analysis(df, n_boot=20, seed=1)
    for k, v in res["main"].point.items():
        assert res["person_weighted"].point[k] == pytest.approx(v, abs=1e-3), k


# ---------------------------------------------------------------------------
# Selections: setup failures and sensitivity filters
# ---------------------------------------------------------------------------

BASE = dict(participant_id="p1", session_index=1, created_at="2026-11-01T00:00:00Z",
            competitor="cartesia", voice="jane", ours_call=1, preference=1, reasons="tone",
            comment="", scored="true", setup_failure_reason="", fatal_tts_ours="false",
            fatal_tts_competitor="false", ck_slow_llm="false", readback_ok_ours="true",
            readback_ok_competitor="true", call1_naturalness=4, call1_tone=4, call1_accuracy=4,
            call2_naturalness=3, call2_tone=3, call2_accuracy=3)


def make_rows(overrides):
    rows = []
    for i, o in enumerate(overrides):
        r = dict(BASE, session_id=o.get("session_id", f"s{i + 1}"))
        r.update(o)
        rows.append({k: ("" if v is None else str(v)) for k, v in r.items()})
    return az.normalize_export(pd.DataFrame(rows, columns=az.REQUIRED_COLUMNS))


@pytest.fixture()
def flagged():
    unscored = dict(scored="false", preference=None, setup_failure_reason="never_spoke",
                    readback_ok_ours=None, readback_ok_competitor=None)
    return make_rows([
        dict(session_id="ok"),
        dict(session_id="slow", ck_slow_llm="true", preference=-2),
        dict(session_id="rb_bad", readback_ok_competitor="false", preference=0),
        dict(session_id="rb_missing", readback_ok_ours=None),
        dict(session_id="no_answer", preference=None),
        dict(session_id="fatal_ours_c1", fatal_tts_ours="true", **unscored),
        dict(session_id="fatal_comp_c1", fatal_tts_competitor="true", **unscored),
        dict(session_id="fatal_ours_c2", fatal_tts_ours="true", **(unscored | {"ours_call": 2})),
        dict(session_id="fatal_both", fatal_tts_ours="true", fatal_tts_competitor="true", **unscored),
        dict(session_id="fail_with_answer", **(unscored | {"preference": -2})),
    ])


def ids(df):
    return set(df["session_id"])


def test_main_selection_excludes_setup_failures(flagged):
    assert ids(az.select_main(flagged)) == {"ok", "slow", "rb_bad", "rb_missing"}


def test_sensitivity_no_slow_llm(flagged):
    assert ids(az.select_no_slow_llm(flagged)) == {"ok", "rb_bad", "rb_missing"}


def test_sensitivity_readback_ok(flagged):
    # Missing read-back counts as not verified.
    assert ids(az.select_readback_ok(flagged)) == {"ok", "slow"}


def test_sensitivity_fatal_as_loss(flagged):
    sel = az.select_fatal_as_loss(flagged).set_index("session_id")
    assert set(sel.index) == {"ok", "slow", "rb_bad", "rb_missing",
                              "fatal_ours_c1", "fatal_comp_c1", "fatal_ours_c2"}
    # Fatal error on ours -> clear loss for ours, whichever call it was.
    assert sel.loc["fatal_ours_c1", "preference"] == 2
    assert sel.loc["fatal_ours_c1", "ours_result"] == -1
    assert sel.loc["fatal_ours_c2", "preference"] == -2
    assert sel.loc["fatal_ours_c2", "ours_result"] == -1
    assert sel.loc["fatal_comp_c1", "preference"] == -2
    assert sel.loc["fatal_comp_c1", "ours_result"] == 1
    # Scored rows keep the participant's own answer.
    assert sel.loc["slow", "preference"] == -2


def test_setup_failures_do_not_affect_main_fit():
    """Whatever an unscored row says, the main fit must ignore it."""
    df = az.normalize_export(sim.simulate_export(300, elo_gaps=TRUE_GAPS, seed=12,
                                                 setup_failure_rate=0.3))
    failed = ~df["scored"]
    assert failed.sum() > 50
    poisoned = df.copy()
    # Unscored rows now all claim ours clearly won.
    poisoned.loc[failed, "preference"] = np.where(poisoned.loc[failed, "ours_call"] == 1, -2, 2)
    poisoned = az.add_outcomes(poisoned)
    a, b = main_fit(df), main_fit(poisoned)
    for k in a:
        assert a[k] == pytest.approx(b[k], abs=1e-9), k
    assert not (~az.select_main(poisoned)["scored"]).any()
    counts = az.descriptive_counts(df)
    assert counts["setup_failures"] == int(failed.sum())
    assert sum(counts["setup_failures_by_reason"].values()) == int(failed.sum())
    assert counts["main_fit_sessions"] == int((~failed).sum())


def test_missing_competitor_gives_nan_not_crash(flagged):
    rows = az.select_main(flagged)
    M = az.participant_cell_counts(rows, ["p1"])
    theta = az.fit_bt_davidson(M.sum(axis=0))
    assert math.isfinite(theta[0])                  # cartesia present
    assert np.isnan(theta[1]) and np.isnan(theta[2])  # no elevenlabs / inworld data


# ---------------------------------------------------------------------------
# Components and reasons
# ---------------------------------------------------------------------------

def test_component_paired_difference_uses_ours_call():
    df = make_rows([
        # ours is call 1 rated 5, competitor call 2 rated 2 -> +3
        dict(participant_id="a", ours_call=1, call1_naturalness=5, call2_naturalness=2),
        # ours is call 2 rated 4, competitor call 1 rated 5 -> -1
        dict(participant_id="b", ours_call=2, call1_naturalness=5, call2_naturalness=4),
        # missing rating -> dropped from the pair
        dict(participant_id="c", ours_call=1, call1_naturalness=None, call2_naturalness=1),
    ])
    W = az.bootstrap_weights(3, 50, np.random.default_rng(0))
    comp = az.component_analysis(df, ["a", "b", "c"], W)
    d = comp["paired_ours_minus_competitor"]["cartesia"]["naturalness"]
    assert d["n"] == 2 and d["mean"] == pytest.approx(1.0)
    assert comp["means"]["ours"]["naturalness"]["mean"] == pytest.approx(4.5)
    assert comp["means"]["cartesia"]["naturalness"]["mean"] == pytest.approx((2 + 5 + 1) / 3)


def test_reasons_tallied_by_winner():
    df = make_rows([
        dict(ours_call=1, preference=-2, reasons="human;tone"),   # ours wins
        dict(ours_call=2, preference=-1, reasons="speed"),        # cartesia wins
        dict(ours_call=1, preference=0, reasons=""),              # tie
    ])
    r = az.descriptive_counts(df)["reasons_by_winner"]
    assert r["ours"] == {"sessions": 1, "codes": {"human": 1, "tone": 1}}
    assert r["cartesia"] == {"sessions": 1, "codes": {"speed": 1}}
    assert r["no preference"]["sessions"] == 1


# ---------------------------------------------------------------------------
# CLI end to end
# ---------------------------------------------------------------------------

def test_cli_writes_report_and_json(tmp_path, capsys):
    csv = tmp_path / "export.csv"
    sim.simulate_export(40, elo_gaps=TRUE_GAPS, seed=13, setup_failure_rate=0.1,
                        slow_llm_rate=0.1, readback_fail_rate=0.1).to_csv(csv, index=False)
    out = tmp_path / "out.json"
    assert az.main([str(csv), "--boot", "50", "--seed", "3", "--json", str(out)]) == 0
    text = capsys.readouterr().out
    for heading in ["1. Data", "3. Main outcome", "Davidson nu", "transitivity",
                    "4. Person-weighted", "5. Sensitivity", "6. Component", "7. Reasons"]:
        assert heading in text
    res = json.loads(out.read_text())
    assert res["settings"]["n_boot"] == 50
    assert set(res["main"]["estimates"]) >= {"gap_ours_minus_cartesia", "nu", "order_elo_call1_advantage"}
    assert len(res["sensitivity"]) == 3
