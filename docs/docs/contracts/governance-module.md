---
sidebar_position: 6
title: Governance Module
---

# Governance Module

The Governance Module is the route authority. It decides which flight routes can be insured and on what terms. It does not implement token voting, "governance" here means route and terms management by the owner and delegated admins.

## Defaults and per-route terms

The module stores global defaults (`default_premium`, `default_payoff`, `default_delay_hours`) and optional per-route overrides. Any unset per-route field falls back to the default. Every write validates: premium and payoff positive, payoff greater than premium, delay threshold positive, and the owner-configured term limits below.

## Term limits

Route writes are open to admins, a deliberately weaker role than owner. To cap the blast radius of a single compromised admin key, the owner configures magnitude bounds via `set_term_limits(max_payoff, max_payoff_ratio)`:

- `max_payoff_ratio` caps `payoff / premium` (unit-free, active by default at 100, cannot be disabled). A vault-sized payoff must carry a vault-scale premium instead of dust.
- `max_payoff` is an absolute per-policy payoff ceiling in asset units (0 disables it; set a deployment-appropriate value at wiring time).

Both are enforced on every route write and on `set_defaults`. Lowering the limits retroactively de-lists oversized routes: `route_status` reports them Disabled until the terms or the limits are adjusted. The limits also bind at purchase time: the Controller re-validates the terms a purchase actually uses — including an existing flight bucket's snapshotted terms — through `terms_valid`, so a lowered cap stops new buyers on pre-existing oversized buckets too (existing policies keep their snapshotted terms for settlement).

A route is the tuple `(flight_id, origin, destination)`. Only one origin and destination pair is allowed per flight number.

## Route states

- **Active**: insurable, resolves to concrete terms.
- **Disabled**: temporarily not insurable, reversible.
- **Unknown**: never whitelisted.

Removal is strict: a route must be disabled before it can be removed.

## Functions

| Function | Caller | Purpose |
|---|---|---|
| `route_status(flight_id, origin, destination)` | Anyone | Returns Active with resolved terms, Disabled, or Unknown |
| `get_defaults()` | Anyone | Current default terms |
| `get_term_limits()` | Anyone | Current `(max_payoff, max_payoff_ratio)` bounds |
| `terms_valid(terms)` | Anyone | Whether already-resolved terms satisfy the current limits and economic validity rules (used by the Controller to re-check bucket snapshots) |
| `whitelist_route`, `update_route_terms`, `disable_route`, `enable_route`, `remove_route` | Owner or admin | Route management |
| `set_defaults` | Owner | Update global defaults |
| `set_term_limits` | Owner | Bound the economics any route write may carry |
| `add_admin`, `remove_admin`, `is_admin` | Owner | Delegate route management |

`update_route_terms` uses per-field operations, each of premium, payoff, and delay hours can independently be kept, set to a new value, or reset to the default.

Routes live in persistent storage with no on-chain enumeration. Route listings for frontends are built off-chain from emitted events.
