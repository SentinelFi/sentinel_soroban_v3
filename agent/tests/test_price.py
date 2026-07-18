"""Tests for the pricing service. Requires artifacts/ to be present
(they are committed) — no network, no chain."""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

from app.main import PREMIUM_MAX, PREMIUM_MIN, app, price_from_probability


def _req(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "flight_id": "AA100",
        "carrier": "AA",
        "origin": "JFK",
        "dest": "LAX",
        "payoff_usdc": 450,
        "month": 8,
        "day_of_month": 21,
        "day_of_week": 7,
    }
    base.update(overrides)
    return base


def test_price_endpoint_shape() -> None:
    with TestClient(app) as client:
        resp = client.post("/price", json=_req())
        assert resp.status_code == 200
        body = resp.json()
        assert 0.0 <= body["p_delay"] <= 1.0
        assert PREMIUM_MIN <= body["premium_usdc"] <= PREMIUM_MAX
        # Stellar 7-decimal base units
        assert body["premium_base_units"] == round(body["premium_usdc"] * 10_000_000)
        assert body["model_version"]


def test_rails_clamp() -> None:
    # p=0 → floor; p=1 with big payoff → cap.
    low_usdc, low_units = price_from_probability(0.0, 450)
    assert low_usdc == PREMIUM_MIN
    assert low_units == round(PREMIUM_MIN * 10_000_000)
    high_usdc, _ = price_from_probability(1.0, 10_000)
    assert high_usdc == PREMIUM_MAX


def test_unknown_categories_do_not_crash() -> None:
    # handle_unknown="ignore" on the encoder — a brand-new carrier/airport
    # must still price (falls back to numeric features only).
    with TestClient(app) as client:
        resp = client.post("/price", json=_req(carrier="ZZ", origin="XXX", dest="YYY"))
        assert resp.status_code == 200


def test_token_gate() -> None:
    os.environ["AGENT_TOKEN"] = "sekrit"
    try:
        with TestClient(app) as client:
            assert client.post("/price", json=_req()).status_code == 401
            ok = client.post(
                "/price", json=_req(), headers={"Authorization": "Bearer sekrit"}
            )
            assert ok.status_code == 200
            # healthz stays open
            assert client.get("/healthz").status_code == 200
    finally:
        del os.environ["AGENT_TOKEN"]
