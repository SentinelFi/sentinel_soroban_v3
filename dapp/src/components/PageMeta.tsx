import { useCopy } from "../copy"

/**
 * Per-route <title> + meta description. React 19 hoists <title>/<meta>
 * rendered anywhere in the tree into <head>, so each route gets its own
 * search-result title and snippet instead of the one static title in
 * index.html (which stays as the pre-JS fallback; social scrapers use
 * the og:* tags there and never read these). Rendered beside each
 * <Route> in App.tsx so the route table and its metadata stay one edit
 * point.
 */
export function PageMeta({
	title,
	description,
}: {
	/** Page part of the title; omit for the home/default title. */
	title?: string
	description?: string
}) {
	const t = useCopy()
	return (
		<>
			<title>
				{title
					? `${title} — ${t.brand.name}`
					: `${t.brand.name} — Flight Delay Insurance Market`}
			</title>
			{description ? <meta name="description" content={description} /> : null}
		</>
	)
}
