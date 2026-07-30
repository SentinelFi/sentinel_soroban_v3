/**
 * Pixel-art slot. Slots listed in ASSETS render the real Pixellab sprite
 * from /px/<name>.png with `pixelated` scaling; unknown names fall back
 * to the original labeled dashed box, so unfinished slots stay visible.
 *
 * Scenes (banners) crop with object-cover; sprites keep their aspect with
 * object-contain. Keep sprite slots at integer multiples of native size.
 *
 * `icon` — for tiny slots where the placeholder label can't fit: renders
 * a glyph, keeps the slot name in data-pixel/title.
 */

import { cn } from "../lib/utils"

const ASSETS: Record<string, { alt: string; scene?: boolean }> = {
	"hero-airport": {
		alt: "Night airport: control tower, radar dish and runway lights under a starry midnight sky",
		scene: true,
	},
	"hero-airfield": {
		alt: "Night airfield panorama: control tower and city skyline under a starry midnight sky, with a lit runway strip running along the bottom",
		scene: true,
	},
	"betslip-plane": {
		alt: "Pixel airplane taking off, gold motion streaks behind it",
	},
	"vault-house": {
		alt: "Bank vault door with a glowing lock dial beside stacks of gold coins",
	},
	"avatar-pilot": { alt: "Pixel pilot in aviator cap giving a thumbs up" },
	"trophy-win": { alt: "Golden trophy cup" },
	"coin-usdc": { alt: "Gold coin with dollar sign" },
	"weather-storm": { alt: "Storm cloud with lightning bolt" },
	"weather-sun": { alt: "Golden sun" },
	"radar-sweep": { alt: "Radar dish with a sweeping green tracking line" },
	"stamp-covered": { alt: "Green rubber stamp reading COVERED" },
	"stamp-denied": { alt: "Red rubber stamp reading DENIED" },
	"stamp-paid": { alt: "Gold rubber stamp reading PAID" },
	"ticket-tear": { alt: "Perforated torn edge of a paper ticket" },
}

export function PixelArt({
	name,
	className,
	icon = false,
}: {
	name: string
	className?: string
	icon?: boolean
}) {
	const asset = ASSETS[name]
	if (asset) {
		return (
			<img
				src={`/px/${name}.png`}
				alt={asset.alt}
				data-pixel={name}
				draggable={false}
				className={cn(
					"pixelated select-none",
					asset.scene ? "object-cover" : "object-contain",
					className,
				)}
			/>
		)
	}
	return (
		<div
			aria-hidden="true"
			data-pixel={name}
			title={`[PIXEL: ${name}]`}
			className={cn(
				"pixelated flex items-center justify-center overflow-hidden border-2 border-dashed border-line-strong bg-inset/60 text-center",
				className,
			)}
		>
			{icon ? (
				<span className="font-board text-[14px] leading-none text-mute">
					▦
				</span>
			) : (
				<span className="label-px px-2 py-1 text-mute">
					[PIXEL: {name}]
				</span>
			)}
		</div>
	)
}
