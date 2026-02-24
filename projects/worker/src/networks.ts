export const NETWORKS = {
  testnet: {
    indexerUrl: "https://testnet-idx.4160.nodely.dev",
  },
  betanet: {
    indexerUrl: "https://betanet-idx.4160.nodely.dev",
  },
  fnet: {
    indexerUrl: "https://fnet-idx.4160.nodely.dev",
  },
  mainnet: {
    indexerUrl: "https://mainnet-idx.4160.nodely.dev",
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;
export const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkName[];
