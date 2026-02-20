import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { decodeAddress, getApplicationAddress, waitForConfirmation } from "algosdk";
import { EscregClient, EscregComposer, EscregFactory } from "./generated/EscregGenerated";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { chunk, emptySigner, getIncreaseBudgetBuilder } from "./util";
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
    this.algorand = algorand.setSuggestedParamsCacheTimeout(3 * 60 * 1000).setDefaultValidityWindow(1000);
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
    concurrency = 1,
    passIdx = 1,
    prevPassFails = 0,
  }: {
    appIds: bigint[];
    skipCheck?: true;
    debug?: true;
    concurrency?: number;
    passIdx?: number;
    prevPassFails?: number;
  }): Promise<string[]> {
    if (!this.writerAccount) throw new Error("Write operation requested without writer account");

    if (!skipCheck) {
      if (debug) console.time("getApplicationAddress");
      const addresses = appIds.map((appId) => getApplicationAddress(appId).toString());
      if (debug) console.timeEnd("getApplicationAddress");
      if (debug) console.time("lookup");
      const results = await this.lookup({ addresses, concurrency, debug });
      if (debug) console.timeEnd("lookup");

      const existing = Object.entries(results)
        .map(([address, v], idx) => ({ address, appId: appIds[idx], idx, exists: v !== undefined }))
        .filter(({ exists }) => exists)
        .sort(({ idx: a }, { idx: b }) => (a < b ? 1 : -1));

      if (existing.length) {
        if (debug) {
          console.warn(`Found ${existing.length} existing appIDs`);
          // console.debug(existing.map(({ exists, idx, ...rest }) => rest));
        }
        for (const { idx } of existing) {
          appIds.splice(idx, 1);
        }
      }
    }

    if (!appIds.length) return [];

    const perTxn = 8;
    const groupChunks = chunk(appIds, perTxn * 15);
    if (debug)
      console.debug(
        `Starting registration for ${appIds.length} appIds${skipCheck ? " with skipCheck" : ""}${perTxn ? ` and perGroup ${perTxn}` : ""}${passIdx > 1 ? ` on pass ${passIdx}` : ""}`,
      );

    if (debug) console.debug(`Doing ${appIds.length} in ${groupChunks.length} chunks with concurrency ${concurrency}`);

    let thisPassFails = 0;
    let failedAppIds: bigint[] = [];
    let chunkIdx = 0;
    // Process chunks in parallel with pMap
    const results = await pMap(
      groupChunks,
      async (groupChunk) => {
        if (debug)
          console.debug(
            `Starting chunkIdx ${chunkIdx++}/${groupChunks.length} ${groupChunk.length > 1 ? groupChunk[0] + ".." + groupChunk[groupChunk.length - 1] : groupChunk[0]}`,
          );
        const appIdChunk = chunk(groupChunk, perTxn);

        // Helper to add registerList calls to a builder
        const addRegisterListCalls = (builder: EscregComposer<any>) => {
          for (const appIds of appIdChunk) {
            const boxReferences = appIds.map((appId) => decodeAddress(getApplicationAddress(appId).toString()).publicKey.slice(0, 4));
            builder = builder.registerList({ args: { appIds }, boxReferences });
          }
          return builder;
        };

        // Build initial group
        let group = addRegisterListCalls(this.client.newGroup());

        // Check if budget increase is needed via simulation
        const increasedBuilder = await getIncreaseBudgetBuilder(
          group,
          () => this.client.newGroup(),
          this.writerAccount!.addr.toString(),
          this.writerAccount!.signer,
          this.algorand.client.algod,
        );

        // If increased budget needed, rebuild with increaseBudget prepended
        if (increasedBuilder) {
          group = addRegisterListCalls(increasedBuilder);
        }

        const composer = await group.composer();
        const { transactions } = await composer.build();
        const txns = transactions.map(({ txn }) => txn);
        const signed = await transactions[0].signer(
          txns,
          txns.map((_, i) => i),
        );
        try {
          await this.algorand.client.algod.sendRawTransaction(signed).do();
          await waitForConfirmation(this.algorand.client.algod, txns[0].txID(), 8);
        } catch (e) {
          if (debug) {
            console.error(`Chunk ${chunkIdx}/${groupChunks.length} failed with error:`, e);
            console.debug(`Failed chunk appIds: ${groupChunk.join(" ")}`);
            thisPassFails += groupChunk.length;
            failedAppIds.push(...groupChunk);
          }
        }

        return txns.map((t) => t.txID());
      },
      { concurrency },
    );

    if (thisPassFails && thisPassFails === prevPassFails) {
      // If the number of failures is the same as the previous pass, it likely means these are persistent failures
      throw new Error(`Pass ${passIdx} failed with ${thisPassFails} failures, same as previous pass. Aborting to avoid infinite retries.`);
    } else if (thisPassFails) {
      console.warn(`Pass failed with ${thisPassFails} failures. Retrying failed ones.`);
      const nextResults = await this.register({
        appIds: failedAppIds,
        skipCheck: true,
        debug,
        concurrency,
        prevPassFails: thisPassFails,
        passIdx: passIdx + 1,
      });
      results.push(nextResults);
    }

    // Flatten results
    return results.flat();
  }

  async lookup({
    addresses,
    concurrency = 1,
    debug,
  }: {
    addresses: string[];
    concurrency?: number;
    debug?: boolean;
  }): Promise<LookupResult> {
    const chunks = chunk(addresses, 128);
    const start = Date.now();

    if (debug) {
      console.debug(
        `Looking up ${addresses.length} addresses in ${chunks.length} chunks (${addresses.length <= 128 ? addresses.length : "128 per chunk"}) with concurrency ${concurrency}`,
      );
    }

    // Process chunks in parallel with pMap
    const results = await pMap(
      chunks,
      async (addressesChunk, chunkIndex) => {
        let composer: EscregComposer<any> = this.client.newGroup();

        const addressChunks = chunk(addressesChunk, 63);

        for (const addresses of addressChunks) {
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
          const found = Object.values(out).filter((appId) => appId !== undefined).length;
          console.debug(`Chunk ${chunkIndex + 1}/${chunks.length} completed: ${found}/${addressesChunk.length} addresses found`);
        }

        return out;
      },
      { concurrency },
    );

    if (debug) {
      console.debug("Merging results...");
    }
    // Merge all results
    // const finalResult = results.reduce((acc, result) => ({ ...acc, ...result }), {}); // slow
    const finalResult: LookupResult = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result)) {
        finalResult[key] = value;
      }
    }

    if (debug) {
      console.debug("Results merged.");
      const elapsed = (Date.now() - start) / 1000;
      const totalFound = Object.values(finalResult).filter((appId) => appId !== undefined).length;
      console.debug(`Lookup completed: ${totalFound}/${addresses.length} addresses found in ${elapsed} seconds`);
    }

    return finalResult;
  }

  async withdraw({ amount, debug }: { amount: bigint; debug?: boolean }): Promise<string> {
    if (!this.writerAccount) throw new Error("Write operation requested without writer account");

    if (debug) {
      console.debug(`Withdrawing ${amount.toString()} microAlgos from contract ${this.appId}`);
    }

    const { confirmation } = await this.client.send.withdraw({
      args: { amount },
      sender: this.writerAccount.addr.toString(),
      signer: this.writerAccount.signer,
      extraFee: (1000).microAlgo(),
    });

    if (debug) {
      console.debug(`Withdrawal successful. Transaction ID: ${confirmation.txn.txn.txID()}`);
    }

    return confirmation.txn.txn.txID();
  }
}
