import { useEffect, useState } from "react"

/** Trailing-edge debounce: returns `value` once it has been stable for
 *  `delayMs`. Feed the debounced value into a react-query key so typing
 *  "JFK" issues one request, not three. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delayMs)
		return () => clearTimeout(timer)
	}, [value, delayMs])
	return debounced
}
