"""Tests for the prediction service. Requires artifacts/ to be present
(they are committed) — no network, no chain."""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

from app.main import BASELINE_COVERED_RATE, app


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


def test_unknown_categories_do_not_crash() -> None:
    # handle_unknown="ignore" on the encoder — a brand-new carrier/airport
    # must still predict (falls back to numeric features only).
    with TestClient(app) as client:
        resp = client.post("/predict", json=_req(carrier="ZZ", origin="XXX", dest="YYY"))
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
