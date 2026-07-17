export type TxState = "idle" | "awaiting" | "confirming" | "success" | "error"

export type FlightStatus =
	| "NotInitiated"
	| "Active"
	| "Landed"
	| "ToBeSettledOnTime"
	| "ToBeSettledDelayed"
	| "Settled"
