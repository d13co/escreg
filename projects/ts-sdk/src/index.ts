import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { Address, Account, makeEmptyTransactionSigner } from "algosdk";
import { EscregClient, EscregComposer, EscregFactory } from "./generated/EscregGenerated";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { chunk, emptySigner } from "./util";

export type LookupResult = Record<string, bigint | undefined>;

export class EscregSDK {
  public appId: bigint;
  public client: EscregClient;
  public algorand: AlgorandClient;
  public readerAccount = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";
  public writerAccount;

  constructor({
    appId,
    algorand,
    writerAccount,
    readerAccount,
  }: {
    appId: bigint;
    algorand: AlgorandClient;
    writerAccount?: Address & TransactionSignerAccount & Account;
    readerAccount?: string;
  }) {
    this.appId = appId;
    this.algorand = algorand;
    this.client = new EscregFactory({ algorand }).getAppClientById({
      appId,
      defaultSender: writerAccount ? writerAccount.toString() : undefined,
      defaultSigner: writerAccount ? writerAccount.signer : undefined,
    });
    if (readerAccount) this.readerAccount = readerAccount;
    if (writerAccount) this.writerAccount = writerAccount;
  }

  async register({ appIds }: { appIds: bigint[] }): Promise<string[]> {
    // max = 7 per txn, 112 per group
    if (appIds.length > 112) {
      throw new Error(`Too many app IDs (${appIds.length}) max 112`);
    }

    const chunks = chunk(appIds, 7);

    let composer: EscregComposer<any> = this.client.newGroup();

    for (const appIds of chunks) {
      composer = composer.registerList({ args: { appIds }, maxFee: (2000).microAlgo() });
    }

    const { confirmations } = await composer.send({ coverAppCallInnerTransactionFees: true, populateAppCallResources: true });

    return confirmations.map(({ txn }) => txn.txn.txID());
  }

  async lookup({ addresses }: { addresses: string[] }): Promise<LookupResult> {
    // max 8 per txn, 128 per group
    if (addresses.length > 128) {
      throw new Error(`Too many app IDs (${addresses.length}) max 128`);
    }

    const chunks = chunk(addresses, 8);

    let composer: EscregComposer<any> = this.client.newGroup();

    for (const addresses of chunks) {
      composer = composer.getList({ args: { addresses }, sender: this.readerAccount, signer: emptySigner });
    }

    const { returns: grpReturn } = await composer.simulate({ allowEmptySignatures: true, allowUnnamedResources: true, extraOpcodeBudget: 170_000 });

    const out: LookupResult = {};

    let i = 0;
    for (const txnReturns of grpReturn) {
      for (const appId of txnReturns) {
        const address = addresses[i++];
        out[address] = appId || undefined;
      }
    }
    return out;
  }
}
