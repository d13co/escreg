import { ABIMethod, ABIType, Address, base64ToBytes, bytesToBase64, makeEmptyTransactionSigner } from "algosdk";

/**
 * Helpers the lookup path is built from. Everything here depends on algosdk and nothing else, which
 * is what lets the light entry point stay off algokit-utils and the generated client - see
 * `fullUtil.ts` for the helpers that do need them.
 */

export const emptySigner = makeEmptyTransactionSigner();

/**
 * Encode a box name as a box listing cursor, i.e. the `next-token` algod's box listing returns.
 *
 * The cursor is the box name to resume *after*, in the goal app call arg form, so the cursor of
 * the last box a caller has processed is where a resumed listing should pick up.
 *
 * @param name - Raw box name.
 * @returns The name as a `b64:`-prefixed cursor.
 */
export function boxCursor(name: Uint8Array): string {
  return `b64:${bytesToBase64(name)}`;
}

/**
 * Decode a box listing cursor back to the box name it resumes after.
 *
 * @param cursor - Cursor in the form `boxCursor` builds, i.e. algod's `next-token`.
 * @returns The raw box name, or undefined for a cursor not in the `b64:` form.
 */
export function decodeBoxCursor(cursor: string): Uint8Array | undefined {
  return cursor.startsWith("b64:") ? base64ToBytes(cursor.slice(4)) : undefined;
}

/**
 * Compare two box names the way algod's listing orders them: byte by byte, shorter name first on a
 * shared prefix. A listing resumed after a cursor only returns names that sort above it.
 *
 * @returns Negative when `a` sorts first, positive when `b` does, 0 when they are the same name.
 */
export function compareBoxNames(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Decode a registry bucket box value into the app IDs it holds.
 *
 * Buckets store big-endian 8-byte app IDs packed back to back with no length header, so the
 * entry count is the box length divided by 8.
 *
 * @param value - Raw box value, as returned by `getApplicationBoxByName`.
 * @returns The app IDs in the bucket, in insertion order.
 * @throws If the value length is not a multiple of 8.
 */
export function decodeBucket(value: Uint8Array): bigint[] {
  if (value.length % 8 !== 0) {
    throw new Error(`Malformed bucket: ${value.length} bytes is not a multiple of 8`);
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Array.from({ length: value.length / 8 }, (_, i) => view.getBigUint64(i * 8));
}

export function chunk<T>(array: T[], size: number): T[][] {
  if (size <= 0) throw new Error("Chunk size must be greater than 0");

  const result: T[][] = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }

  return result;
}

/**
 * Map over items with a bounded number of them in flight, results in input order.
 *
 * The SDK's own take on `p-map`, so that neither entry point carries a runtime dependency for
 * twenty lines of work. The first rejection is thrown and no further items are started, though the
 * ones already in flight are left to settle.
 *
 * @param items - Items to map over.
 * @param mapper - Called with each item and its index.
 * @param concurrency - Items in flight at once.
 * @returns The mapped values, in the order of `items`.
 */
export async function mapConcurrent<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R>, concurrency = 1): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let next = 0;
  let failed = false;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await mapper(items[index], index);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    }),
  );

  return results;
}

/**
 * True for the error a node raises when an app call's args are too long for it: either the per-arg
 * 4096-byte cap, or - on a node predating AVM 13 - the 2048-byte cap on the whole arg list.
 *
 * @param e - Error thrown by a send or simulate call.
 * @returns Whether the call was rejected for oversized app args.
 */
export function isArgTooLongError(e: unknown): boolean {
  return /ApplicationArgs.*length is too long/.test(String((e as Error)?.message ?? e));
}

/**
 * True for the error a node raises when a box a call reads was not referenced - which is what a node
 * that ignores or refuses AVM 13 access lists says about a group that named its boxes in them.
 *
 * @param e - Error thrown by a send or simulate call.
 * @returns Whether the call was rejected over an unavailable box.
 */
export function isBoxRefError(e: unknown): boolean {
  return /invalid Box reference|tx\.Access/.test(String((e as Error)?.message ?? e));
}

/**
 * The registry's `getList`, spelled out rather than read from the app spec: the spec is a 10KB
 * literal in the generated client, and the lookup path needs four bytes of it. `npm run check:abi`
 * holds this to the contract's own signature so the two cannot drift.
 */
export const getListMethod = new ABIMethod({
  name: "getList",
  desc: "Get the app IDs for multiple app escrow addresses. Returns 0 for each if not registered in the contract.",
  args: [{ type: "address[]", name: "addresses", desc: "App Escrows to get the app IDs for" }],
  returns: { type: "uint64[]", desc: "Array of app IDs for each input address, or 0 if not registered" },
});

const addressArrayType = ABIType.from("address[]");
const uint64ArrayType = ABIType.from("uint64[]");

/** Prefix every ARC-4 return value is logged behind. */
const RETURN_PREFIX = new Uint8Array([0x15, 0x1f, 0x7c, 0x75]);

/**
 * Encode the `address[]` argument of a `getList` call.
 *
 * @param addresses - Addresses the call resolves; may be empty, for a transaction that only carries
 *   references for the rest of its group.
 * @returns The ABI-encoded argument.
 */
export const encodeAddresses = (addresses: string[]): Uint8Array => addressArrayType.encode(addresses) as Uint8Array;

/**
 * Decode the app IDs a `getList` call returned from the log it left behind.
 *
 * @param log - Last log of the transaction's result.
 * @returns The app IDs, in call order; 0 for an address that is not registered.
 */
export function decodeAppIds(log: Uint8Array | undefined): bigint[] {
  if (!log || log.length < RETURN_PREFIX.length || RETURN_PREFIX.some((b, i) => log[i] !== b)) {
    throw new Error("getList did not return an ARC-4 value");
  }
  // a copy rather than a view: the decoder reads from byte 0 of whatever buffer it is handed
  return uint64ArrayType.decode(new Uint8Array(log.subarray(RETURN_PREFIX.length))) as bigint[];
}

/**
 * The registry boxes a set of addresses lives in: the leading four bytes of each address, deduplicated,
 * since escrows sharing a prefix share a bucket and so cost the group only one reference between them.
 *
 * @param addresses - Addresses a group resolves.
 * @returns One box name per distinct bucket, in first-seen order.
 */
export function distinctBoxKeys(addresses: string[]): Uint8Array[] {
  const keys = new Map<string, Uint8Array>();
  for (const address of addresses) {
    const key = Address.fromString(address).publicKey.slice(0, 4);
    keys.set(bytesToBase64(key), key);
  }
  return [...keys.values()];
}
