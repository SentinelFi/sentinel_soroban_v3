import {
	createContext,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react"
import storage from "../util/storage"
import { wallet, fetchBalances, type MappedBalances } from "../util/wallet"
import { networkPassphrase as appNetworkPassphrase } from "../contracts/util"
import controllerClient from "../contracts/controller"
import governanceClient from "../contracts/governance_module"
import oracleClient from "../contracts/oracle_aggregator"
import riskVaultClient from "../contracts/risk_vault"
import mockUsdcClient from "../contracts/mock_usdc"
import flightPoolManagerClient from "../contracts/flight_pool_manager"

/** Every contract client singleton — publicKey is synced on address
 *  change (below) so ANY page can build write transactions without
 *  remembering to call a per-page sync hook. */
const CONTRACT_CLIENTS = [
	controllerClient,
	governanceClient,
	oracleClient,
	riskVaultClient,
	mockUsdcClient,
	flightPoolManagerClient,
]

const signTransaction = wallet.signTransaction.bind(wallet)

/**
 * A good-enough implementation of deepEqual.
 *
 * Used in this file to compare MappedBalances.
 *
 * Should maybe add & use a new dependency instead, if needed elsewhere.
 */
function deepEqual<T>(a: T, b: T): boolean {
	if (a === b) {
		return true
	}

	const bothAreObjects =
		a && b && typeof a === "object" && typeof b === "object"

	return Boolean(
		bothAreObjects &&
		Object.keys(a).length === Object.keys(b).length &&
		Object.entries(a).every(([k, v]) => deepEqual(v, b[k as keyof T])),
	)
}

export interface WalletContextType {
	address?: string
	balances: MappedBalances
	isPending: boolean
	network?: string
	networkPassphrase?: string
	/**
	 * True when the connected wallet reports a network passphrase that
	 * differs from the one this app builds transactions for (FSA-L01).
	 * Only ever true when we positively know the wallet's network (an
	 * empty/unknown passphrase never trips it), so it raises no false
	 * alarms. Consumers surface a warning; signing is not hard-blocked.
	 */
	networkMismatch: boolean
	signTransaction: typeof wallet.signTransaction
	updateBalances: () => Promise<void>
}

const POLL_INTERVAL = 1000
// Consecutive failed polls tolerated before treating the wallet as gone.
// freighter-api gives the extension a hard 2s to answer `isConnected`
// before reporting "not connected" — a deadline it routinely misses right
// after the approval popup closes, while locked, or under load — so one
// failed tick means "busy", not "disconnected".
const MAX_POLL_FAILURES = 3

export const WalletContext = createContext<WalletContextType>({
	isPending: true,
	balances: {},
	networkMismatch: false,
	updateBalances: async () => {},
	signTransaction,
})

export const WalletProvider = ({ children }: { children: React.ReactNode }) => {
	const [balances, setBalances] = useState<MappedBalances>({})
	const [address, setAddress] = useState<string>()
	const [network, setNetwork] = useState<string>()
	const [networkPassphrase, setNetworkPassphrase] = useState<string>()
	const [isPending, startTransition] = useTransition()
	const popupLock = useRef(false)
	const pollFailures = useRef(0)

	// Mirror of the wallet state for the mount-once polling loop below.
	// The loop reads through this ref so every tick compares against the
	// CURRENT values — a plain closure would forever compare against the
	// first render's undefineds, defeating the change checks.
	const current = useRef({ address, network, networkPassphrase })
	useEffect(() => {
		current.current = { address, network, networkPassphrase }
	})

	// Scaffold-stellar clients need `publicKey` set to build write
	// transactions; sync all singletons here, once, for every page.
	useEffect(() => {
		for (const client of CONTRACT_CLIENTS) {
			client.options.publicKey = address
		}
	}, [address])

	const nullify = () => {
		pollFailures.current = 0
		setAddress(undefined)
		setNetwork(undefined)
		setNetworkPassphrase(undefined)
		setBalances({})
		storage.setItem("walletId", "")
		storage.setItem("walletAddress", "")
		storage.setItem("walletNetwork", "")
		storage.setItem("networkPassphrase", "")
	}

	const updateBalances = useCallback(async () => {
		if (!address) {
			setBalances({})
			return
		}

		const newBalances = await fetchBalances(address)
		setBalances((prev) => {
			if (deepEqual(newBalances, prev)) return prev
			return newBalances
		})
	}, [address])

	useEffect(() => {
		void updateBalances()
	}, [updateBalances])

	const updateCurrentWalletState = async () => {
		// There is no way, with StellarWalletsKit, to check if the wallet is
		// installed/connected/authorized. We need to manage that on our side by
		// checking our storage item. "safe" mode: a legacy non-JSON value
		// returns null instead of throwing — an uncaught throw here would
		// kill the polling loop for good (no next tick ever scheduled).
		const walletId = storage.getItem("walletId", "safe")
		const walletNetwork = storage.getItem("walletNetwork", "safe")
		const walletAddr = storage.getItem("walletAddress", "safe")
		const passphrase = storage.getItem("networkPassphrase", "safe")
		const { address, network, networkPassphrase } = current.current

		if (
			!address &&
			walletAddr !== null &&
			walletNetwork !== null &&
			passphrase !== null
		) {
			setAddress(walletAddr)
			setNetwork(walletNetwork)
			setNetworkPassphrase(passphrase)
		}

		if (!walletId) {
			nullify()
		} else {
			if (popupLock.current) return
			// If our storage item is there, then we try to get the user's address &
			// network from their wallet. Note: `getAddress` MAY open their wallet
			// extension, depending on which wallet they select!
			try {
				popupLock.current = true
				wallet.setWallet(walletId)
				if (walletId !== "freighter" && walletAddr !== null) return
				const [a, n] = await Promise.all([
					wallet.getAddress(),
					wallet.getNetwork(),
				])
				pollFailures.current = 0

				if (!a.address) storage.setItem("walletId", "")
				if (
					a.address !== address ||
					n.network !== network ||
					n.networkPassphrase !== networkPassphrase
				) {
					storage.setItem("walletAddress", a.address)
					setAddress(a.address)
					setNetwork(n.network)
					setNetworkPassphrase(n.networkPassphrase)
				}
			} catch (e) {
				// A failed tick usually means the extension was briefly busy,
				// not that the user disconnected — only a sustained streak of
				// failures signs the user out. Wiping eagerly here is what
				// used to disconnect wallets seconds after they connected.
				pollFailures.current += 1
				if (pollFailures.current >= MAX_POLL_FAILURES) {
					nullify()
				}
				// log the error (instead of throwing) so we have visibility
				// but do not crash the app process
				console.error(e)
			} finally {
				popupLock.current = false
			}
		}
	}

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>
		let isMounted = true

		// Create recursive polling function to check wallet state continuously
		const pollWalletState = async () => {
			if (!isMounted) return

			await updateCurrentWalletState()

			if (isMounted) {
				timer = setTimeout(() => void pollWalletState(), POLL_INTERVAL)
			}
		}

		// Get the wallet address when the component is mounted for the first time
		startTransition(async () => {
			await updateCurrentWalletState()
			// Start polling after initial state is loaded

			if (isMounted) {
				timer = setTimeout(() => void pollWalletState(), POLL_INTERVAL)
			}
		})

		// Clear the timeout and stop polling when the component unmounts
		return () => {
			isMounted = false
			if (timer) clearTimeout(timer)
		}
	}, []) // eslint-disable-line react-hooks/exhaustive-deps -- it SHOULD only run once per component mount

	// Only flag a mismatch when the wallet has actually reported a
	// passphrase (non-Freighter wallets may leave it empty) — an unknown
	// network must not raise a false warning.
	const networkMismatch = Boolean(
		networkPassphrase && networkPassphrase !== appNetworkPassphrase,
	)

	const contextValue = useMemo(
		() => ({
			address,
			network,
			networkPassphrase,
			networkMismatch,
			balances,
			updateBalances,
			isPending,
			signTransaction,
		}),
		[
			address,
			network,
			networkPassphrase,
			networkMismatch,
			balances,
			updateBalances,
			isPending,
		],
	)

	return <WalletContext value={contextValue}>{children}</WalletContext>
}
