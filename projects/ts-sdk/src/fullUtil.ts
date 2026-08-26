import { Algodv2, makeEmptyTransactionSigner, modelsv2, TransactionSigner } from "algosdk";
import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { EscregComposer } from "./generated/EscregGenerated.js";
import { BoxKeyBatch, SizedBoxKey } from "./types.js";
import { FNET_ALGOD_PORT, FNET_ALGOD_SERVER } from "./constants.js";

/**
 * Helpers for the write and scan paths. Unlike `util.ts`, everything here reaches for algokit-utils
 * or the generated client, so nothing on the lookup path may import this module.
 */

export const fnetNodelyClient = AlgorandClient.fromConfig({
  algodConfig: {
    server: FNET_ALGOD_SERVER,
    port: FNET_ALGOD_PORT,
  },
});

/** Prepend the 'c' key prefix to a public key for the userCredits box */
export function creditBoxRef(publicKey: Uint8Array): Uint8Array {
  const ref = new Uint8Array(1 + publicKey.length);
  ref[0] = 0x63; // 'c'
  ref.set(publicKey, 1);
  return ref;
}

/** Box references a single transaction can carry, i.e. the AVM's `MaxAppBoxReferences`. */
export const maxBoxRefsPerTxn = 8;

/** Box read and write budget, in bytes, that each box reference in a group grants. */
export const bytesPerBoxRef = 1024;

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
