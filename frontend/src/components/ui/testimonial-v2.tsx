import React from "react"
import { motion } from "framer-motion"

/**
 * "Built in the open" marquee.
 *
 * No invented testimonials, no stock faces — every card states something
 * true and checkable about the protocol. Keeps the original section's
 * three-column scrolling treatment.
 */

interface Fact {
	label: string
	text: string
	href?: string
}

const facts: Fact[] = [
	{
		label: "Test suite",
		text: "370 automated tests run green across the contract workspace on every commit.",
	},
	{
		label: "Audits",
		text: "Five audit rounds completed and remediated before the testnet deployment.",
	},
	{
		label: "Foundations",
		text: "Vault, access control, and token logic build on OpenZeppelin Stellar contracts.",
	},
	{
		label: "Solvency",
		text: "100% collateralised. The full payout is locked in the vault before a purchase completes.",
	},
	{
		label: "Risk vault",
		text: "Underwriter capital sits in a 4626-style vault with a FIFO withdrawal queue.",
	},
	{
		label: "Automation",
		text: "Settlement is a pipeline, not a promise: oracle updates, classification, and payouts run on timers.",
	},
	{
		label: "On-chain",
		text: "Every contract is live on Stellar testnet and inspectable down to the storage entry.",
		href: "https://stellar.expert/explorer/testnet/contract/CD7KCPQJFYSEUPJ43VXC6RIYCF4WPTVUHH3ANWNPYXTYGE2NBRXGFTXB",
	},
	{
		label: "Recovery",
		text: "Unclaimed payouts sweep back transparently after the 60-day claim window closes.",
	},
	{
		label: "Open source",
		text: "Apache-2.0 licensed. Read the contracts, the executor, and this UI on GitHub.",
		href: "https://github.com/SentinelFi",
	},
]

const firstColumn = facts.slice(0, 3)
const secondColumn = facts.slice(3, 6)
const thirdColumn = facts.slice(6, 9)

function FactsColumn(props: {
	className?: string
	facts: Fact[]
	duration?: number
}) {
	return (
		<div className={props.className}>
			<motion.ul
				animate={{
					translateY: "-50%",
				}}
				transition={{
					duration: props.duration || 20,
					repeat: Infinity,
					ease: "linear",
					repeatType: "loop",
				}}
				className="flex flex-col gap-6 pb-6 bg-transparent list-none m-0 p-0"
			>
				{[
					...new Array(2).fill(0).map((_, index) => (
						<React.Fragment key={index}>
							{props.facts.map(({ label, text, href }, i) => (
								<li
									key={`${index}-${i}`}
									aria-hidden={index === 1 ? "true" : "false"}
									className="p-8 rounded-3xl border border-border max-w-xs w-full bg-card transition-colors duration-300 hover:border-primary/30 select-none"
								>
									<p className="stat-label mb-3">{label}</p>
									<p className="text-muted-foreground leading-relaxed font-normal m-0">
										{text}
									</p>
									{href && (
										<a
											href={href}
											target="_blank"
											rel="noopener noreferrer"
											tabIndex={index === 1 ? -1 : 0}
											className="inline-block mt-4 text-sm text-primary hover:text-primary/80 transition-colors"
										>
											Verify it &rarr;
										</a>
									)}
								</li>
							))}
						</React.Fragment>
					)),
				]}
			</motion.ul>
		</div>
	)
}

export default function TestimonialsSection() {
	return (
		<section
			aria-labelledby="proof-heading"
			className="bg-transparent py-24 relative overflow-hidden"
		>
			<div className="container px-4 z-10 mx-auto">
				<div className="flex flex-col items-center justify-center max-w-[540px] mx-auto mb-16">
					<h2
						id="proof-heading"
						className="text-4xl md:text-5xl font-extrabold tracking-tight text-center text-foreground"
					>
						Built in the open
					</h2>
					<p className="text-center mt-5 text-muted-foreground text-lg leading-relaxed max-w-sm">
						No testimonials yet. The contracts speak for themselves.
					</p>
				</div>

				<div
					className="flex justify-center gap-6 mt-10 [mask-image:linear-gradient(to_bottom,transparent,black_10%,black_90%,transparent)] max-h-[560px] overflow-hidden"
					role="region"
					aria-label="Verifiable protocol facts"
				>
					<FactsColumn facts={firstColumn} duration={26} />
					<FactsColumn
						facts={secondColumn}
						className="hidden md:block"
						duration={32}
					/>
					<FactsColumn
						facts={thirdColumn}
						className="hidden lg:block"
						duration={28}
					/>
				</div>
			</div>
		</section>
	)
}
