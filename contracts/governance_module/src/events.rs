// Topic prefix scheme: ["sentinel", "route", <action>] for route-lifecycle
// events, ["sentinel", "gov", <action>] for governance-meta events. Every
// event leads with `"sentinel"` so a shared off-chain indexer can subscribe
// once and discriminate against unrelated Soroban contracts (L-03 — audit).
//
// route.listed / route.updated carry Option<T> values (NOT resolved):
// indexers mirror option-ness in their schema (NULL = UseDefault) and
// resolve against the latest gov.defaults singleton at read time. This
// means a defaults change does not require updating every UseDefault
// route — the indexer just updates its defaults row.

use soroban_sdk::{contractevent, Address, Symbol};

#[contractevent(topics = ["sentinel", "route_listed"], data_format = "map")]
pub struct RouteListed {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
    pub(crate) premium: Option<i128>,
    pub(crate) payoff: Option<i128>,
    pub(crate) delay_hours: Option<u32>,
}

#[contractevent(topics = ["sentinel", "route_disabled"], data_format = "map")]
pub struct RouteDisabled {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
}

#[contractevent(topics = ["sentinel", "route_enabled"], data_format = "map")]
pub struct RouteEnabled {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
}

#[contractevent(topics = ["sentinel", "route_updated"], data_format = "map")]
pub struct RouteUpdated {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
    pub(crate) premium: Option<i128>,
    pub(crate) payoff: Option<i128>,
    pub(crate) delay_hours: Option<u32>,
}

#[contractevent(topics = ["sentinel", "route_removed"], data_format = "map")]
pub struct RouteRemoved {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
}

#[contractevent(topics = ["sentinel", "gov_defaults"], data_format = "map")]
pub struct GovDefaults {
    pub(crate) premium: i128,
    pub(crate) payoff: i128,
    pub(crate) delay_hours: u32,
}

#[contractevent(topics = ["sentinel", "gov_admin_added"], data_format = "single-value")]
pub struct GovAdminAdded {
    #[topic]
    pub(crate) admin: Address,
}

#[contractevent(topics = ["sentinel", "gov_admin_removed"], data_format = "single-value")]
pub struct GovAdminRemoved {
    #[topic]
    pub(crate) admin: Address,
}
