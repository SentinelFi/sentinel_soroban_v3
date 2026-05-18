// Topic prefix scheme: ["route", <action>] for route-lifecycle events,
// ["gov", <action>] for governance-meta events.
//
// route.listed / route.updated carry Option<T> values (NOT resolved):
// indexers mirror option-ness in their schema (NULL = UseDefault) and
// resolve against the latest gov.defaults singleton at read time. This
// means a defaults change does not require updating every UseDefault
// route — the indexer just updates its defaults row.

use soroban_sdk::{contractevent, Address, Symbol};

#[contractevent(topics = ["route", "listed"], data_format = "map")]
pub struct RouteListed {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
    pub(crate) premium: Option<i128>,
    pub(crate) payoff: Option<i128>,
    pub(crate) delay_hours: Option<u32>,
}

#[contractevent(topics = ["route", "disabled"], data_format = "map")]
pub struct RouteDisabled {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
}

#[contractevent(topics = ["route", "enabled"], data_format = "map")]
pub struct RouteEnabled {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
}

#[contractevent(topics = ["route", "updated"], data_format = "map")]
pub struct RouteUpdated {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
    pub(crate) premium: Option<i128>,
    pub(crate) payoff: Option<i128>,
    pub(crate) delay_hours: Option<u32>,
}

#[contractevent(topics = ["route", "removed"], data_format = "map")]
pub struct RouteRemoved {
    #[topic]
    pub(crate) flight_id: Symbol,
    pub(crate) origin: Symbol,
    pub(crate) dest: Symbol,
}

#[contractevent(topics = ["gov", "defaults"], data_format = "map")]
pub struct GovDefaults {
    pub(crate) premium: i128,
    pub(crate) payoff: i128,
    pub(crate) delay_hours: u32,
}

#[contractevent(topics = ["gov", "admin_added"], data_format = "single-value")]
pub struct GovAdminAdded {
    #[topic]
    pub(crate) admin: Address,
}

#[contractevent(topics = ["gov", "admin_removed"], data_format = "single-value")]
pub struct GovAdminRemoved {
    #[topic]
    pub(crate) admin: Address,
}
