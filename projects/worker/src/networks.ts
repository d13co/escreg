// Nodely indexer hosts. The free tier is served from `.dev`; the paid tier
// (used when an indexer API token is supplied) is served from `.io`.
const INDEXER_HOSTS = {
  testnet: "testnet-idx.4160.nodely",
  betanet: "betanet-idx.4160.nodely",
  fnet: "fnet-idx.4160.nodely",
  mainnet: "mainnet-idx.4160.nodely",
} as const;

export type NetworkName = keyof typeof INDEXER_HOSTS;
export const NETWORK_NAMES = Object.keys(INDEXER_HOSTS) as NetworkName[];

/** Build the indexer URL for a network, using the `.io` tier when a token is set. */
export function indexerUrl(network: NetworkName, hasToken: boolean): string {
  return `https://${INDEXER_HOSTS[network]}.${hasToken ? "io" : "dev"}`;
}
