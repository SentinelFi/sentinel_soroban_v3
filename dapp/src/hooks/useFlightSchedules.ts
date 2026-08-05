import { useQuery } from "@tanstack/react-query"

/**
 * Scheduled departure times for (flight, day) pairs, read from the
 * backend's `flight_schedules` snapshot table (written by sale-auth at
 * buy time) via POST /api/flight-schedules. Display garnish only: the
 * endpoint is DB-optional and fail-open, so "no data" is a normal
 * answer — callers render nothing when a pair is absent.
 */

export interface ScheduleKey {
	flightId: string
	/** UTC-midnight unix seconds — the on-chain bucket key. */
	date: bigint
}

interface ApiScheduleRow {
	flight_id: string
	date: number
	scheduled_out: number | null
	scheduled_in: number | null
}

/** Map of "<flightId>:<dateSecs>" → scheduled departure (unix seconds). */
export function useFlightSchedules(items: ScheduleKey[]) {
	const body = items.map((i) => ({
		flight_id: i.flightId,
		date: Number(i.date),
	}))
	const cacheKey = body
		.map((i) => `${i.flight_id}:${i.date}`)
		.sort()
		.join(",")
	return useQuery({
		queryKey: ["flightSchedules", cacheKey],
		enabled: body.length > 0,
		staleTime: 5 * 60_000,
		retry: 1,
		queryFn: async () => {
			const res = await fetch("/api/flight-schedules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ items: body }),
			})
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			const data = (await res.json()) as { schedules?: ApiScheduleRow[] }
			const map = new Map<string, number>()
			for (const s of data.schedules ?? []) {
				if (s.scheduled_out != null)
					map.set(`${s.flight_id}:${s.date}`, s.scheduled_out)
			}
			return map
		},
	})
}
