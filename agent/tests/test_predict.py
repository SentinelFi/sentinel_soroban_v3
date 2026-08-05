"""Tests for the prediction service. Requires artifacts/ to be present
(they are committed) — no network, no chain."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from app.main import BASELINE_COVERED_RATE, app

# The delay tiers: URL suffix → threshold. Optional artifacts, so the
# tier tests skip (never fail) on an instance that only has the live set.
TIERS = (("30m", 30), ("60m", 60))


def _req(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "carrier": "AA",
        "origin": "JFK",
        "dest": "LAX",
        "month": 8,
        "day_of_month": 21,
        "day_of_week": 7,
    }
    base.update(overrides)
    return base


def test_predict_endpoint_shape() -> None:
    with TestClient(app) as client:
        resp = client.post("/predict", json=_req())
        assert resp.status_code == 200
        body = resp.json()
        assert 0.0 <= body["p_covered"] <= 1.0
        assert body["risk"] in ("low", "moderate", "high")
        assert body["baseline"] == BASELINE_COVERED_RATE
        assert body["vs_baseline"] == round(body["p_covered"] / BASELINE_COVERED_RATE, 2)
        assert body["model_version"]


def test_optional_fields_default() -> None:
    # dep_time_hhmm and distance_mi are optional (noon / 1000 mi).
    with TestClient(app) as client:
        implicit = client.post("/predict", json=_req())
        explicit = client.post("/predict", json=_req(dep_time_hhmm=1200, distance_mi=1000))
        assert implicit.status_code == explicit.status_code == 200
        assert implicit.json() == explicit.json()


def test_unknown_carrier_rejected() -> None:
    # The model only knows the IATA codes it was trained on. An unknown
    # carrier would one-hot to all-zeros and silently predict without the
    # carrier signal (the 2026-07-29 ICAO pricing bug) — reject instead.
    with TestClient(app) as client:
        for code in ("ZZ", "UAL", "AAL"):
            resp = client.post("/predict", json=_req(carrier=code))
            assert resp.status_code == 422, code
            assert "IATA" in resp.json()["detail"]


def test_icao_iata_pairs_differ() -> None:
    # Sanity: real IATA codes carry signal — two different carriers on the
    # same route/date must not collapse to one probability.
    with TestClient(app) as client:
        p_ua = client.post("/predict", json=_req(carrier="UA")).json()["p_covered"]
        p_aa = client.post("/predict", json=_req(carrier="AA")).json()["p_covered"]
        assert p_ua != p_aa


def test_unknown_airports_do_not_crash() -> None:
    # Airports stay handle_unknown="ignore" — a new airport still predicts
    # (falls back to the remaining features); only carrier is validated.
    with TestClient(app) as client:
        resp = client.post("/predict", json=_req(origin="XXX", dest="YYY"))
        assert resp.status_code == 200


def test_token_gate() -> None:
    os.environ["AGENT_TOKEN"] = "sekrit"
    try:
        with TestClient(app) as client:
            assert client.post("/predict", json=_req()).status_code == 401
            ok = client.post(
                "/predict", json=_req(), headers={"Authorization": "Bearer sekrit"}
            )
            assert ok.status_code == 200
            # healthz stays open
            assert client.get("/healthz").status_code == 200
    finally:
        del os.environ["AGENT_TOKEN"]


# ─── Delay tiers ──────────────────────────────────────────────────────────


def _tier_or_skip(client: TestClient, suffix: str, **overrides: object) -> dict:
    resp = client.post(f"/predict/{suffix}", json=_req(**overrides))
    if resp.status_code == 503:
        pytest.skip(f"/predict/{suffix} artifacts not present")
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.parametrize("suffix,threshold", TIERS)
def test_tier_endpoint_shape(suffix: str, threshold: int) -> None:
    with TestClient(app) as client:
        body = _tier_or_skip(client, suffix)
        assert 0.0 <= body["p_covered"] <= 1.0
        assert body["risk"] in ("low", "moderate", "high")
        assert body["threshold_min"] == threshold
        # Graded against its OWN baseline, not the 180m one.
        assert body["baseline"] != BASELINE_COVERED_RATE
        assert body["vs_baseline"] == round(body["p_covered"] / body["baseline"], 2)
        assert f"arr{threshold}m" in body["model_version"]


@pytest.mark.parametrize("suffix,_threshold", TIERS)
def test_tier_rejects_unknown_carrier(suffix: str, _threshold: int) -> None:
    # Same ICAO guard as /predict — the tiers share the carrier vocabulary.
    with TestClient(app) as client:
        _tier_or_skip(client, suffix)  # skip early if unloaded
        resp = client.post(f"/predict/{suffix}", json=_req(carrier="UAL"))
        assert resp.status_code == 422
        assert "IATA" in resp.json()["detail"]


def test_shorter_threshold_is_likelier_in_aggregate() -> None:
    # Per-request monotonicity isn't guaranteed (three independently fitted
    # models), but a 30-min miss must be commoner than a 3-hour one across
    # a spread of routes — otherwise a label or artifact got swapped.
    routes = [
        ("AA", "JFK", "LAX"), ("UA", "ORD", "SFO"), ("DL", "ATL", "MCO"),
        ("WN", "DEN", "PHX"), ("B6", "BOS", "FLL"),
    ]
    with TestClient(app) as client:
        _tier_or_skip(client, "30m")
        _tier_or_skip(client, "60m")
        for carrier, origin, dest in routes:
            over = {"carrier": carrier, "origin": origin, "dest": dest}
            p180 = client.post("/predict", json=_req(**over)).json()["p_covered"]
            p60 = client.post("/predict/60m", json=_req(**over)).json()["p_covered"]
            p30 = client.post("/predict/30m", json=_req(**over)).json()["p_covered"]
            assert p30 > p60 > p180, f"{carrier} {origin}-{dest}: {p30} {p60} {p180}"


def test_models_endpoint_lists_live_model() -> None:
    with TestClient(app) as client:
        body = client.get("/models").json()
        assert body[0]["threshold_min"] == 180
        assert body[0]["endpoint"] == "/predict"
        assert body[0]["baseline"] == BASELINE_COVERED_RATE
        # Descending threshold order, and every entry names a real path.
        thresholds = [m["threshold_min"] for m in body]
        assert thresholds == sorted(thresholds, reverse=True)


def test_live_predict_untouched_by_tiers() -> None:
    # The regression that matters: /predict's response is exactly the five
    # fields it always had, graded off the 180m constant.
    with TestClient(app) as client:
        body = client.post("/predict", json=_req()).json()
        assert set(body) == {
            "p_covered", "risk", "baseline", "vs_baseline", "model_version",
        }
        assert body["baseline"] == BASELINE_COVERED_RATE
        assert "arr180m" in body["model_version"]
