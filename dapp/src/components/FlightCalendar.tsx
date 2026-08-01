import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"

/**
 * Themed flight-date calendar used by the insurance slip. Renders a compact
 * field that toggles a month-grid popover. Flights must be in the future
 * (lead-time), so the minimum selectable day is TOMORROW — today and past days
 * are disabled. The selected value is a `YYYY-MM-DD` string, which the slip
 * converts to a midnight-UTC u64 for buy_insurance (unchanged).
 *
 * FUN     = pixel calendar: hard grid, VT323 day numbers, arcade selected cell.
 * SERIOUS = clean calendar: rounded cells, clean mono numerals, soft hover,
 *           a highlight ring on the selected day. No pixel fonts in serious.
 *
 * Keyboard: arrow keys move the focused day (skipping disabled), Enter/Space
 * selects, Escape closes. The grid is a roving-tabindex listbox-ish widget.
 */

const DOW = ["S", "M", "T", "W", "T", "F", "S"]
const WEEKDAYS_FULL = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
]

/** Local YYYY-MM-DD for a Date (calendar days are display-local). */
function ymd(d: Date): string {
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, "0")
	const day = String(d.getDate()).padStart(2, "0")
	return `${y}-${m}-${day}`
}

/** Start-of-day clone. */
function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function FlightCalendar({
	value,
	onChange,
}: {
	/** selected YYYY-MM-DD, or "" for none */
	value: string
	onChange: (dateStr: string) => void
}) {
	const { theme } = useTheme()
	const t = useCopy()
	const serious = theme === "serious"

	// Minimum selectable day = tomorrow (flights must be future / lead-time).
	const minDay = useMemo(() => {
		const d = startOfDay(new Date())
		d.setDate(d.getDate() + 1)
		return d
	}, [])

	const today = useMemo(() => startOfDay(new Date()), [])

	const selectedDate = useMemo(
		() => (value ? parseYmd(value) : null),
		[value],
	)

	const [open, setOpen] = useState(false)
	// month currently shown in the grid (anchored to the 1st)
	const [viewMonth, setViewMonth] = useState<Date>(() => {
		const base = selectedDate ?? minDay
		return new Date(base.getFullYear(), base.getMonth(), 1)
	})
	// day that has keyboard focus within the grid
	const [focusDay, setFocusDay] = useState<Date>(() => selectedDate ?? minDay)

	const wrapRef = useRef<HTMLDivElement>(null)
	const gridRef = useRef<HTMLDivElement>(null)
	const fieldRef = useRef<HTMLButtonElement>(null)

	// Roving tabindex done for real: DOM focus follows focusDay, so
	// keyboard users SEE the focus ring on the day cell and screen
	// readers HEAR each day announced as they arrow around.
	useEffect(() => {
		if (!open) return
		gridRef.current
			?.querySelector<HTMLButtonElement>(`[data-day="${ymd(focusDay)}"]`)
			?.focus()
	}, [open, focusDay, viewMonth])

	// close on outside click / Escape
	useEffect(() => {
		if (!open) return
		function onDoc(e: MouseEvent) {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setOpen(false)
			}
		}
		document.addEventListener("mousedown", onDoc)
		return () => document.removeEventListener("mousedown", onDoc)
	}, [open])

	// when opening, sync the view + focus to the current selection
	function openPopover() {
		const base = selectedDate ?? minDay
		setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1))
		setFocusDay(base)
		setOpen(true)
	}

	// keep the focused cell inside the visible month
	useEffect(() => {
		if (!open) return
		if (
			focusDay.getFullYear() !== viewMonth.getFullYear() ||
			focusDay.getMonth() !== viewMonth.getMonth()
		) {
			setViewMonth(new Date(focusDay.getFullYear(), focusDay.getMonth(), 1))
		}
	}, [focusDay, open, viewMonth])

	const year = viewMonth.getFullYear()
	const month = viewMonth.getMonth()
	const firstWeekday = new Date(year, month, 1).getDay()
	const daysInMonth = new Date(year, month + 1, 0).getDate()

	// leading blanks so the 1st lands under its weekday, then the days —
	// chunked into weeks so the ARIA grid can expose real rows
	const cells: Array<Date | null> = []
	for (let i = 0; i < firstWeekday; i++) cells.push(null)
	for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))
	const weeks: Array<Array<Date | null>> = []
	for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

	// can we page back? only if the previous month still holds a selectable day
	const prevMonthEnd = new Date(year, month, 0) // last day of prev month
	const canPrev = prevMonthEnd.getTime() >= minDay.getTime()

	function isDisabled(d: Date): boolean {
		return startOfDay(d).getTime() < minDay.getTime()
	}

	function selectDay(d: Date) {
		if (isDisabled(d)) return
		onChange(ymd(d))
		setOpen(false)
	}

	function onGridKey(e: React.KeyboardEvent) {
		let delta = 0
		switch (e.key) {
			case "ArrowLeft":
				delta = -1
				break
			case "ArrowRight":
				delta = 1
				break
			case "ArrowUp":
				delta = -7
				break
			case "ArrowDown":
				delta = 7
				break
			case "Enter":
			case " ":
				e.preventDefault()
				selectDay(focusDay)
				return
			case "Escape":
				setOpen(false)
				fieldRef.current?.focus()
				return
			default:
				return
		}
		e.preventDefault()
		let next = new Date(focusDay)
		next.setDate(next.getDate() + delta)
		// clamp to the minimum selectable day
		if (next.getTime() < minDay.getTime()) next = new Date(minDay)
		setFocusDay(startOfDay(next))
	}

	const label = selectedDate ? formatLong(selectedDate) : t.slip.datePlaceholder

	return (
		<div ref={wrapRef} className="w3-cal">
			<button
				ref={fieldRef}
				type="button"
				className="field-px w3-cal-field"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => (open ? setOpen(false) : openPopover())}
			>
				<span className={value ? "" : "w3-cal-value-empty"}>{label}</span>
				<span aria-hidden="true" className="text-mute">
					{serious ? "▾" : "▾"}
				</span>
			</button>

			{open && (
				<div
					className="w3-cal-pop"
					role="dialog"
					aria-label={t.slip.dateLabel}
				>
					<div className="w3-cal-head">
						<button
							type="button"
							className="w3-cal-nav"
							aria-label={t.slip.calPrevAria}
							disabled={!canPrev}
							onClick={() =>
								setViewMonth(new Date(year, month - 1, 1))
							}
						>
							{serious ? (
								<ChevronLeft className="h-4 w-4" strokeWidth={2} />
							) : (
								"‹"
							)}
						</button>
						<span className="w3-cal-title" aria-live="polite">
							{monthTitle(viewMonth, serious)}
						</span>
						<button
							type="button"
							className="w3-cal-nav"
							aria-label={t.slip.calNextAria}
							onClick={() =>
								setViewMonth(new Date(year, month + 1, 1))
							}
						>
							{serious ? (
								<ChevronRight className="h-4 w-4" strokeWidth={2} />
							) : (
								"›"
							)}
						</button>
					</div>

					{/* rows use display:contents so the ARIA grid is valid
					    (grid → row → gridcell) without breaking the CSS grid
					    layout; the container itself is no longer a tab stop —
					    the focused day button is the single stop (roving). */}
					<div
						ref={gridRef}
						className="w3-cal-grid"
						role="grid"
						onKeyDown={onGridKey}
					>
						<div role="row" style={{ display: "contents" }}>
							{DOW.map((d, i) => (
								<div
									key={i}
									role="columnheader"
									aria-label={WEEKDAYS_FULL[i]}
									className="w3-cal-dow"
								>
									{d}
								</div>
							))}
						</div>
						{weeks.map((week, w) => (
							<div
								key={w}
								role="row"
								style={{ display: "contents" }}
							>
								{week.map((d, i) => {
									if (!d)
										return (
											<div
												key={`e${w}-${i}`}
												className="w3-cal-day is-empty"
												aria-hidden="true"
											/>
										)
									const disabled = isDisabled(d)
									const isSel =
										!!selectedDate &&
										ymd(d) === ymd(selectedDate)
									const isToday = ymd(d) === ymd(today)
									const isFocus = ymd(d) === ymd(focusDay)
									return (
										<button
											key={ymd(d)}
											type="button"
											role="gridcell"
											data-day={ymd(d)}
											aria-selected={isSel}
											aria-current={
												isToday ? "date" : undefined
											}
											disabled={disabled}
											tabIndex={isFocus ? 0 : -1}
											className={`w3-cal-day${
												isSel ? " is-selected" : ""
											}${isToday ? " is-today" : ""}`}
											onClick={() => selectDay(d)}
										>
											{d.getDate()}
										</button>
									)
								})}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

/** Parse a YYYY-MM-DD into a local Date at start of day. */
function parseYmd(s: string): Date {
	const [y = 0, m = 1, d = 1] = s.split("-").map(Number)
	return new Date(y, m - 1, d)
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
]

function monthTitle(d: Date, serious: boolean): string {
	const name = MONTHS[d.getMonth()]
	const full = `${name} ${d.getFullYear()}`
	return serious ? full : full.toUpperCase()
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function formatLong(d: Date): string {
	return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`
}
