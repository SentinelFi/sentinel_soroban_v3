import { DatePicker } from "@ark-ui/react/date-picker"
import { Portal } from "@ark-ui/react/portal"
import { ChevronLeft, ChevronRight, Calendar, X } from "lucide-react"
import { useMemo } from "react"
import { parseDate } from "@internationalized/date"

interface FlightDatePickerProps {
	onDateChange?: (dateStr: string) => void
	placeholder?: string
}

function getMinDate(): string {
	const d = new Date(Date.now() + 24 * 60 * 60 * 1000)
	const yyyy = d.getFullYear()
	const mm = String(d.getMonth() + 1).padStart(2, "0")
	const dd = String(d.getDate()).padStart(2, "0")
	return `${yyyy}-${mm}-${dd}`
}

export function FlightDatePicker({
	onDateChange,
	placeholder = "Select flight date",
}: FlightDatePickerProps) {
	const minDateStr = useMemo(() => getMinDate(), [])
	const minDate = useMemo(() => parseDate(minDateStr), [minDateStr])

	return (
		<DatePicker.Root
			min={minDate}
			onValueChange={(details) => {
				if (details.valueAsString[0]) {
					onDateChange?.(details.valueAsString[0])
				}
			}}
		>
			{/* Input + Controls */}
			<DatePicker.Control className="flex items-center gap-2 h-11 rounded-lg border border-input bg-background/60 px-3.5 focus-within:ring-2 focus-within:ring-ring/40 focus-within:ring-offset-1 transition-all duration-200">
				<DatePicker.Input
					className="flex-1 bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground/60"
					placeholder={placeholder}
				/>
				<DatePicker.Trigger className="p-1.5 rounded-md hover:bg-accent transition-colors">
					<Calendar className="h-4 w-4 text-muted-foreground" />
				</DatePicker.Trigger>
				<DatePicker.ClearTrigger className="p-1.5 rounded-md text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors">
					<X className="h-3.5 w-3.5" />
				</DatePicker.ClearTrigger>
			</DatePicker.Control>

			{/* Calendar Popup */}
			<Portal>
				<DatePicker.Positioner>
					<DatePicker.Content className="mt-2 w-full max-w-sm rounded-xl border border-border bg-card shadow-xl shadow-black/10 p-3 z-50">
						{/* Year + Month Select */}
						<div className="flex gap-2 mb-3">
							<DatePicker.YearSelect className="flex-1 rounded-lg border border-input bg-background/60 px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40" />
							<DatePicker.MonthSelect className="flex-1 rounded-lg border border-input bg-background/60 px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40" />
						</div>

						{/* Day View */}
						<DatePicker.View view="day">
							<DatePicker.Context>
								{(datePicker) => (
									<>
										<DatePicker.ViewControl className="flex justify-between items-center mb-2 text-sm font-medium text-foreground">
											<DatePicker.PrevTrigger className="p-1.5 rounded-lg hover:bg-accent transition-colors">
												<ChevronLeft className="h-4 w-4" />
											</DatePicker.PrevTrigger>
											<DatePicker.ViewTrigger className="cursor-pointer px-2 py-1 rounded-lg hover:bg-accent transition-colors">
												<DatePicker.RangeText />
											</DatePicker.ViewTrigger>
											<DatePicker.NextTrigger className="p-1.5 rounded-lg hover:bg-accent transition-colors">
												<ChevronRight className="h-4 w-4" />
											</DatePicker.NextTrigger>
										</DatePicker.ViewControl>

										<DatePicker.Table className="w-full text-center text-sm">
											<DatePicker.TableHead>
												<DatePicker.TableRow>
													{datePicker.weekDays.map((weekDay, id) => (
														<DatePicker.TableHeader
															key={id}
															className="py-1 text-muted-foreground text-xs font-medium"
														>
															{weekDay.short}
														</DatePicker.TableHeader>
													))}
												</DatePicker.TableRow>
											</DatePicker.TableHead>
											<DatePicker.TableBody>
												{datePicker.weeks.map((week, id) => (
													<DatePicker.TableRow key={id}>
														{week.map((day, id) => (
															<DatePicker.TableCell key={id} value={day}>
																<DatePicker.TableCellTrigger className="w-9 h-9 flex items-center justify-center rounded-lg text-foreground hover:bg-primary/10 data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[today]:font-bold data-[outside-range]:text-muted-foreground/40 data-[disabled]:text-muted-foreground/30 data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-transparent focus:ring-2 focus:ring-ring/40 transition-colors">
																	{day.day}
																</DatePicker.TableCellTrigger>
															</DatePicker.TableCell>
														))}
													</DatePicker.TableRow>
												))}
											</DatePicker.TableBody>
										</DatePicker.Table>
									</>
								)}
							</DatePicker.Context>
						</DatePicker.View>

						{/* Month View */}
						<DatePicker.View view="month">
							<DatePicker.Context>
								{(datePicker) => (
									<>
										<DatePicker.ViewControl className="flex justify-between items-center mb-2">
											<DatePicker.PrevTrigger className="p-1.5 rounded-lg hover:bg-accent transition-colors">
												<ChevronLeft className="h-4 w-4" />
											</DatePicker.PrevTrigger>
											<DatePicker.ViewTrigger className="cursor-pointer px-2 py-1 rounded-lg hover:bg-accent transition-colors">
												<DatePicker.RangeText />
											</DatePicker.ViewTrigger>
											<DatePicker.NextTrigger className="p-1.5 rounded-lg hover:bg-accent transition-colors">
												<ChevronRight className="h-4 w-4" />
											</DatePicker.NextTrigger>
										</DatePicker.ViewControl>
										<DatePicker.Table className="w-full text-sm">
											<DatePicker.TableBody>
												{datePicker
													.getMonthsGrid({ columns: 4, format: "short" })
													.map((months, id) => (
														<DatePicker.TableRow key={id}>
															{months.map((month, id) => (
																<DatePicker.TableCell key={id} value={month.value}>
																	<DatePicker.TableCellTrigger className="px-2 py-1.5 rounded-lg text-foreground hover:bg-primary/10 data-[selected]:bg-primary data-[selected]:text-primary-foreground transition-colors">
																		{month.label}
																	</DatePicker.TableCellTrigger>
																</DatePicker.TableCell>
															))}
														</DatePicker.TableRow>
													))}
											</DatePicker.TableBody>
										</DatePicker.Table>
									</>
								)}
							</DatePicker.Context>
						</DatePicker.View>

						{/* Year View */}
						<DatePicker.View view="year">
							<DatePicker.Context>
								{(datePicker) => (
									<>
										<DatePicker.ViewControl className="flex justify-between items-center mb-2">
											<DatePicker.PrevTrigger className="p-1.5 rounded-lg hover:bg-accent transition-colors">
												<ChevronLeft className="h-4 w-4" />
											</DatePicker.PrevTrigger>
											<DatePicker.ViewTrigger className="cursor-pointer px-2 py-1 rounded-lg hover:bg-accent transition-colors">
												<DatePicker.RangeText />
											</DatePicker.ViewTrigger>
											<DatePicker.NextTrigger className="p-1.5 rounded-lg hover:bg-accent transition-colors">
												<ChevronRight className="h-4 w-4" />
											</DatePicker.NextTrigger>
										</DatePicker.ViewControl>
										<DatePicker.Table className="w-full text-sm">
											<DatePicker.TableBody>
												{datePicker.getYearsGrid({ columns: 4 }).map((years, id) => (
													<DatePicker.TableRow key={id}>
														{years.map((year, id) => (
															<DatePicker.TableCell key={id} value={year.value}>
																<DatePicker.TableCellTrigger className="px-2 py-1.5 rounded-lg text-foreground hover:bg-primary/10 data-[selected]:bg-primary data-[selected]:text-primary-foreground transition-colors">
																	{year.label}
																</DatePicker.TableCellTrigger>
															</DatePicker.TableCell>
														))}
													</DatePicker.TableRow>
												))}
											</DatePicker.TableBody>
										</DatePicker.Table>
									</>
								)}
							</DatePicker.Context>
						</DatePicker.View>
					</DatePicker.Content>
				</DatePicker.Positioner>
			</Portal>
		</DatePicker.Root>
	)
}
