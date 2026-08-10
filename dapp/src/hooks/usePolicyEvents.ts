import { useQuery } from "@tanstack/react-query"

/**
 * Purchase + settlement transaction hashes for one (flight, date) pair,
 * read from the backend's chain-event mirror via POST /api/policy-events.
 * Display garnish only: the endpoint is DB-optional and fail-open, so
 * `{ bought: null, settled: null }` is a normal answer — the policy detail
 * timeline renders those steps without explorer links.
 */

export interface PolicyEvents {
	bought: {
		tx_hash: string
		premium_units: string | null
		bought_at: string
	} | null
	settled: {
		tx_hash: string | null
		outcome: string
		settled_at: string
	} | null
}

const EMPTY: PolicyEvents = { bought: null, settled: null }

export function usePolicyEvents(
	flightId: string,
	date: bigint,
	buyer: string | undefined,
	enabled = true,
) {
	return useQuery({
		queryKey: ["policyEvents", flightId, date.toString(), buyer ?? ""],
		enabled: enabled && !!flightId && date > 0n,
		staleTime: 60_000,
		retry: 1,
		queryFn: async (): Promise<PolicyEvents> => {
			try {
				const res = await fetch("/api/policy-events", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						flight_id: flightId,
						date: Number(date),
						buyer: buyer ?? null,
					}),
				})
				if (!res.ok) return EMPTY
				return (await res.json()) as PolicyEvents
			} catch {
				return EMPTY
			}
		},
	})
}
