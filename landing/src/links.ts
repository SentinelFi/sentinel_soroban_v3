export const LINKS = {
  app: "https://sentinel-dapp.vercel.app/",
  earn: "https://sentinel-dapp.vercel.app/earn",
  testnet: "https://sentinel-dapp.vercel.app/",
  wallet: "https://freighter.app/",
  docs: "https://sentinelfi.github.io/sentinel_soroban_v3/",
  stellar: "https://stellar.org/",
  usdc: "https://www.circle.com/multi-chain-usdc/stellar",
  bridge: "https://core.allbridge.io/",
  x: "https://x.com/sentinel_fi/",
  blog: "https://medium.com/@sentineldefi",
  git: "https://github.com/SentinelFi/sentinel_soroban_v3/",
  gitOrg: "https://github.com/SentinelFi",
} as const;

export function utm(url: string, content: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", "landing");
  u.searchParams.set("utm_medium", "web");
  u.searchParams.set("utm_content", content);
  return u.toString();
}
