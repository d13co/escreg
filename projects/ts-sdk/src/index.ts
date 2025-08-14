import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { decodeAddress, getApplicationAddress } from "algosdk";
import { EscregClient, EscregComposer, EscregFactory } from "./generated/EscregGenerated";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { chunk, emptySigner } from "./util";
import pMap from "p-map";

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
    writerAccount?: TransactionSignerAccount;
    readerAccount?: string;
  }) {
    this.appId = appId;
    this.algorand = algorand;
    const args = {
      appId,
      defaultSender: writerAccount ? writerAccount.addr.toString() : undefined,
      defaultSigner: writerAccount ? writerAccount.signer : undefined,
    };
    this.client = new EscregFactory({ algorand }).getAppClientById(args);
    if (readerAccount) this.readerAccount = readerAccount;
    if (writerAccount) this.writerAccount = writerAccount;
  }

  async register({ 
    appIds, 
    skipCheck, 
    debug, 
    concurrency = 1 
  }: { 
    appIds: bigint[]; 
    skipCheck?: true; 
    debug?: true;
    concurrency?: number;
  }): Promise<string[]> {
    if (!this.writerAccount) throw new Error("Write operation requested without writer account");

    if (!skipCheck) {
      const addresses = appIds.map((appId) => getApplicationAddress(appId).toString());
      const results = await this.lookup({ addresses });

      const existing = Object.entries(results)
        .map(([address, v], idx) => ({ address, appId: appIds[idx], idx, exists: v !== undefined }))
        .filter(({ exists }) => exists)
        .sort(({ idx: a }, { idx: b }) => (a < b ? 1 : -1));

      if (existing.length) {
        if (debug) {
          console.warn(`Found ${existing.length} existing appIDs: ${existing.map(({ appId }) => appId).join(" ")}`);
          console.debug(existing.map(({ exists, idx, ...rest }) => rest));
        }
        for (const { idx } of existing) {
          appIds.splice(idx, 1);
        }
      }
    }

    if (!appIds.length) return [];

        // max = 7 per txn, 112 per group

    const groupChunks = chunk(appIds, 7 * 16);

    if (debug) console.debug(`Doing ${appIds.length} in ${groupChunks.length} chunks with concurrency ${concurrency}`);

    // Process chunks in parallel with pMap
    const results = await pMap(groupChunks, async (groupChunk) => {
      const appIdChunk = chunk(groupChunk, 7);
      let composer: EscregComposer<any> = this.client.newGroup();
      for(const appIds of appIdChunk) {
        const boxReferences = appIds.map((appId) => decodeAddress(getApplicationAddress(appId).toString()).publicKey.slice(0, 4));
        composer = composer.registerList({ args: { appIds }, boxReferences, maxFee: (2000).microAlgo() });
      }

      const { confirmations } = await composer.send({
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: false,
      });

      return confirmations.map(({ txn }) => txn.txn.txID());
    }, { concurrency });

    // Flatten results
    return results.flat();
  }

  async lookup({ 
    addresses, 
    concurrency = 1,
    debug
  }: { 
    addresses: string[];
    concurrency?: number;
    debug?: boolean;
  }): Promise<LookupResult> {

    const chunks = chunk(addresses, 128);
    const start = Date.now();

    if (debug) {
      console.debug(`Looking up ${addresses.length} addresses in ${chunks.length} chunks (${addresses.length <= 128 ? addresses.length : '128 per chunk'}) with concurrency ${concurrency}`);
    }

    // Process chunks in parallel with pMap
    const results = await pMap(chunks, async (addressesChunk, chunkIndex) => {
      if (debug) {
        console.debug(`Processing chunk ${chunkIndex + 1}/${chunks.length} (${addressesChunk.length} addresses)`);
      }
      let composer: EscregComposer<any> = this.client.newGroup();

      const addressChunks = chunk(addressesChunk, 63);

      for(const addresses of addressChunks) {
        composer = composer.getList({ args: { addresses }, sender: this.readerAccount, signer: emptySigner });
      }

      const { returns: grpReturn } = await composer.simulate({
        allowEmptySignatures: true,
        allowUnnamedResources: true,
        extraOpcodeBudget: 170_000,
      });

      const out: LookupResult = {};
      let i = 0;
      for (const txnReturns of grpReturn) {
        for (const appId of txnReturns) {
          const address = addressesChunk[i++];
          out[address] = appId || undefined;
        }
      }
      
      if (debug) {
        const found = Object.values(out).filter(appId => appId !== undefined).length;
        console.debug(`Chunk ${chunkIndex + 1}/${chunks.length} completed: ${found}/${addressesChunk.length} addresses found`);
      }
      
      return out;
    }, { concurrency });

    // Merge all results
    const finalResult = results.reduce((acc, result) => ({ ...acc, ...result }), {});
    
    if (debug) {
      const elapsed = (Date.now() - start) / 1000;
      const totalFound = Object.values(finalResult).filter(appId => appId !== undefined).length;
      console.debug(`Lookup completed: ${totalFound}/${addresses.length} addresses found in ${elapsed} seconds`);
    }
    
    return finalResult;
  }
}
