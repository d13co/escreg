import { Algodv2, makeEmptyTransactionSigner, modelsv2, TransactionSigner } from "algosdk";
import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { EscregComposer } from "./generated/EscregGenerated";

export const emptySigner = makeEmptyTransactionSigner();

/** Prepend the 'c' key prefix to a public key for the userCredits box */
export function creditBoxRef(publicKey: Uint8Array): Uint8Array {
  const ref = new Uint8Array(1 + publicKey.length);
  ref[0] = 0x63; // 'c'
  ref.set(publicKey, 1);
  return ref;
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
