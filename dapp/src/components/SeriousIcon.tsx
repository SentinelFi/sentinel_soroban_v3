import {
	CloudRain,
	Coins,
	Landmark,
	Plane,
	Sun,
	Trophy,
	type LucideProps,
} from "lucide-react"

/**
 * Clean line icons for the SERIOUS theme only. The FUN theme keeps its
 * pixel PNG sprites (see PixelArt); serious swaps them for these so the
 * professional skin never shows a pixel-art sprite. lucide-react is the
 * same icon set the reference `frontend/` uses, so it stays coherent with
 * the Midnight Radar look rather than reading as a dropped-in pack.
 *
 * Icons are rendered bare (no tile / chip behind them), sized and coloured
 * by the caller via className — per the design law.
 */
const ICONS = {
	plane: Plane,
	sun: Sun,
	storm: CloudRain,
	trophy: Trophy,
	coin: Coins,
	vault: Landmark,
} as const

export type SeriousIconName = keyof typeof ICONS

export function SeriousIcon({
	name,
	...props
}: { name: SeriousIconName } & LucideProps) {
	const Icon = ICONS[name]
	return <Icon strokeWidth={1.6} {...props} />
}
