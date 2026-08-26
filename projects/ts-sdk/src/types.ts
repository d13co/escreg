import type { Algodv2 } from "algosdk";

/**
 * Anything that carries an algod client the way algokit-utils' `AlgorandClient` does.
 *
 * The lookup SDK is typed against this rather than `AlgorandClient` itself so that the light entry
 * point neither imports nor requires algokit-utils. An `AlgorandClient` satisfies it as-is.
 */
export interface AlgodProvider {
  client: { algod: Algodv2 };
}

/** Map of address to app ID, or undefined if not registered. */
export type LookupResult = Record<string, bigint | undefined>;

/** Map of address to credit balance in microAlgos. */
export type CreditResult = Record<string, bigint>;

/** A registry bucket box, decoded. */
export interface RegistryBucket {
  /** The 4-byte box key: the leading four bytes of every escrow address in the bucket. */
  key: Uint8Array;
  /** Raw box size in bytes. */
  size: number;
  /** The app IDs the bucket holds, in insertion order. */
  appIds: bigint[];
}

/** One page of a registry box listing. */
export interface BucketPage {
  /** The buckets on this page, in listing order. Credit boxes are left out. */
  buckets: RegistryBucket[];
  /** Cursor to resume the listing after this page, or undefined once it is exhausted. */
  next?: string;
  /** Round the page was read at, when the node reports one. */
  round?: number;
}

/** A registry box key with the size of the box it names. */
export interface SizedBoxKey {
  key: Uint8Array;
  size: number;
}

/** Keys for one app call, with the padding references its box budget needs on top of them. */
export interface BoxKeyBatch {
  keys: Uint8Array[];
  /** Extra references to add alongside `keys`, each granting another 1024 bytes of budget. */
  padding: number;
}
