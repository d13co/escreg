import { Algodv2, base64ToBytes, bytesToBase64, makeEmptyTransactionSigner, modelsv2, TransactionSigner } from "algosdk";
import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { EscregComposer } from "./generated/EscregGenerated";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";

export const emptySigner = makeEmptyTransactionSigner();

export const fnetNodelyClient = AlgorandClient.fromConfig({
  algodConfig: {
    server: "https://fnet-api.4160.nodely.dev",
    port: 443,
  },
});

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

/** Prepend the 'c' key prefix to a public key for the userCredits box */
export function creditBoxRef(publicKey: Uint8Array): Uint8Array {
  const ref = new Uint8Array(1 + publicKey.length);
  ref[0] = 0x63; // 'c'
  ref.set(publicKey, 1);
  return ref;
}

/**
 * Length of the leading length header in a bucket of the given size.
 *
 * Mirrors the contract's own `bucketHeaderLen`. Packed buckets are a whole number of 8-byte app
 * IDs, so their size is 0 mod 8; legacy ARC-4 `uint64[]` buckets carry a 2-byte length header
 * ahead of the same app IDs, so their size is 2 mod 8. The two can never be confused, which makes
 * the remainder the header length.
 *
 * @param size - Box size in bytes.
 * @returns 2 for a legacy bucket, 0 for a packed one.
 */
export function bucketHeaderLen(size: number): number {
  return size % 8;
}

/**
 * Decode a registry bucket box value into the app IDs it holds.
 *
 * Buckets store big-endian 8-byte app IDs packed back to back with no length header, so the
 * entry count is the box length divided by 8. To decode a legacy bucket, drop its header first:
 * `decodeBucket(value.subarray(bucketHeaderLen(value.length)))`.
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

/** Box references a single transaction can carry, i.e. the AVM's `MaxAppBoxReferences`. */
export const maxBoxRefsPerTxn = 8;

/** Box read and write budget, in bytes, that each box reference in a group grants. */
export const bytesPerBoxRef = 1024;

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

/**
 * Pack registry box keys into per-transaction batches sized to the box budget they need.
 *
 * Every reference in a group grants 1024 bytes of both read and write budget, so a batch touching
 * more than 1024 bytes per key needs padding references alongside the keys themselves. A batch is
 * capped at 8 keys and at the 8192 bytes 8 references grant, whichever comes first.
 *
 * @param boxes - Keys to pack, each with the size of the box it names.
 * @returns Batches in input order, each with the padding reference count it needs.
 * @throws If a single box is larger than one transaction's references can cover.
 */
export function packBoxKeyBatches(boxes: SizedBoxKey[]): BoxKeyBatch[] {
  const maxBytes = maxBoxRefsPerTxn * bytesPerBoxRef;
  const batches: BoxKeyBatch[] = [];

  let keys: Uint8Array[] = [];
  let bytes = 0;

  const flush = () => {
    if (!keys.length) return;
    batches.push({ keys, padding: Math.max(0, Math.ceil(bytes / bytesPerBoxRef) - keys.length) });
    keys = [];
    bytes = 0;
  };

  for (const { key, size } of boxes) {
    if (size > maxBytes) {
      throw new Error(`Box of ${size} bytes needs more box references than a transaction can carry (${maxBoxRefsPerTxn})`);
    }
    if (keys.length === maxBoxRefsPerTxn || bytes + size > maxBytes) flush();
    keys.push(key);
    bytes += size;
  }
  flush();

  return batches;
}

export function chunk<T>(array: T[], size: number): T[][] {
  if (size <= 0) throw new Error("Chunk size must be greater than 0");

  const result: T[][] = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }

  return result;
}

// sync with "increaseBudget opcode cost" contract tests
export const increaseBudgetBaseCost = 26;
export const increaseBudgetIncrementCost = 22;

const SIMULATE_PARAMS = {
  allowMoreLogging: true,
  allowUnnamedResources: true,
  extraOpcodeBudget: 130_013,
  fixSigners: true,
  allowEmptySignatures: true,
};

const simulateRequest = new modelsv2.SimulateRequest({
  txnGroups: [],
  ...SIMULATE_PARAMS,
});

/* Utility to increase the budget of a transaction group if needed.
 * Simulates and returns undefined if we are under budget, otherwise returns a new builder with an increaseBudget call prepended.
 */
export async function getIncreaseBudgetBuilder(
  builder: EscregComposer<any>,
  newBuilderFactory: () => EscregComposer<any>,
  sender: string,
  signer: TransactionSigner | TransactionSignerAccount,
  algod: Algodv2,
): Promise<EscregComposer<any> | undefined> {
  // maxFee/coverAppCallInnerTransactionFees does not work with builder.simulate() #algokit
  // increase first txn's fee so we do not fail because of fees
  // get atc & modify the first txn fee (need to clone to make txns mutable)
  const atc = (await (await builder.composer()).build()).atc.clone();
  // @ts-ignore private and readonly
  atc.transactions[0].txn.fee = 543_210n;

  // we also need to replace signers with empty signers for simulation
  // otherwise end users would be prompted to sign for this
  // @ts-ignore private and readonly
  atc.transactions = atc.transactions.map((t: any) => {
    t.signer = makeEmptyTransactionSigner();
    return t;
  });

  const {
    simulateResponse: {
      txnGroups: [{ txnResults, appBudgetConsumed = 0 }],
    },
  } = await atc.simulate(algod, simulateRequest);

  // intentionally doing opup even if there is a failure
  // we had code here to return early if there was a failureMessage
  // but that meant that in some cases the actual failure would be obscured by out of budget errors

  // get existing budget: count app calls
  // NOTE only goes 1 level deep in itxns
  const numAppCalls = txnResults.reduce((sum: number, { txnResult }: any) => {
    if (txnResult?.txn.txn.type !== "appl") return sum;
    const innerTxns = txnResult.innerTxns ?? [];
    return sum + 1 + innerTxns.length;
  }, 0);

  let existingBudget = 700 * numAppCalls;

  // budget is OK, returning
  if (appBudgetConsumed! <= existingBudget) return;

  existingBudget += 700 - increaseBudgetBaseCost; // add 700 for increaseBudget, removing its base cost
  const itxnBudgetNeeded = appBudgetConsumed! - existingBudget; // budget to create in itxns

  const itxns = Math.max(0, Math.ceil(itxnBudgetNeeded / (700 - increaseBudgetIncrementCost)));

  const increaseBudgetArgs = {
    args: { itxns },
    extraFee: (itxns * 1000).microAlgo(),
    maxFee: ((itxns + 1) * 1000).microAlgo(),
    note: Math.floor(Math.random() * 100_000_000).toString(),
    sender,
    signer,
  };

  return newBuilderFactory().increaseBudget(increaseBudgetArgs);
}
