---
sidebar_position: 6
title: Governance Module
---

# Governance Module

The Governance Module is the route authority. It decides which flight routes can be insured and on what terms. It does not implement token voting, "governance" here means route and terms management by the owner and delegated admins.

## Defaults and per-route terms

The module stores global defaults (`default_premium`, `default_payoff`, `default_delay_hours`) and optional per-route overrides. Any unset per-route field falls back to the default. Every write validates: premium and payoff positive, payoff greater than premium, delay threshold positive.

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
| `whitelist_route`, `update_route_terms`, `disable_route`, `enable_route`, `remove_route` | Owner or admin | Route management |
| `set_defaults` | Owner | Update global defaults |
| `add_admin`, `remove_admin`, `is_admin` | Owner | Delegate route management |

`update_route_terms` uses per-field operations, each of premium, payoff, and delay hours can independently be kept, set to a new value, or reset to the default.

Routes live in persistent storage with no on-chain enumeration. Route listings for frontends are built off-chain from emitted events.
