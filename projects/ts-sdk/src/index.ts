import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { Address, getApplicationAddress, waitForConfirmation } from "algosdk";
import { EscregClient, EscregComposer } from "./generated/EscregGenerated";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { chunk, creditBoxRef, emptySigner, getIncreaseBudgetBuilder } from "./util";
import { errorTransformer, wrapErrorsInternal } from "./wrapErrors";
import pMap from "p-map";

/** Map of address to app ID, or undefined if not registered. */
export type LookupResult = Record<string, bigint | undefined>;

/**
 * SDK for interacting with the Escreg (Escrow Registry) smart contract.
 * Provides methods for registering app escrow accounts, looking up addresses,
 * managing MBR credits, and admin operations.
 */
export class EscregSDK {
  /** The Escreg application ID. */
  public appId: bigint;
  /** Escreg algokit generated client */
  public client: EscregClient;
  /** Algorand client instance for interacting with the network. */
  public algorand: AlgorandClient;
  /** Address used as sender for read-only simulate calls. Defaults to fee sink, funded mostly everywhere. */
  public readerAccount = "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE";
  /** Account with signing capability for write operations (register, deposit, withdraw). */
  public writerAccount?: TransactionSignerAccount;

  /**
   * @param appId - The Escreg application ID.
   * @param algorand - AlgorandClient instance for interacting with the network.
   * @param writerAccount - Account with signing capability for write operations (register, deposit, withdraw).
   * @param readerAccount - Address used as sender for read-only simulate calls. Defaults to a dummy address.
   */
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
    algorand.registerErrorTransformer(errorTransformer);
    const args = {
      appId,
      defaultSender: writerAccount ? writerAccount.addr.toString() : undefined,
      defaultSigner: writerAccount ? writerAccount.signer : undefined,
    };
    this.client = new EscregClient({ algorand, appId, defaultSender: args.defaultSender, defaultSigner: args.defaultSigner });
    if (readerAccount) this.readerAccount = readerAccount;
    if (writerAccount) this.writerAccount = writerAccount;
  }

  /**
   * Register application escrow accounts in the contract. Derives app escrow addresses from the given app IDs
   * and stores them in the contract state for later lookup. Automatically batches into transaction groups
   * and increases opcode budget as needed. Failed chunks are retried automatically.
   *
   * Unless `skipCheck` is set, existing registrations are filtered out via a lookup before registering.
   *
   * @param appIds - Array of app IDs to register.
   * @param skipCheck - Skip the pre-registration lookup check for existing entries.
   * @param debug - Enable debug logging.
   * @param concurrency - Number of transaction groups to send in parallel.
   * @returns Array of transaction IDs from the registration groups.
   * @throws If writer account is not set, or if credits are insufficient (ERR:CRD).
   */
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

      const existingIndices = new Set(Object.values(results).flatMap((v, idx) => (v !== undefined ? [idx] : [])));

      if (existingIndices.size) {
        if (debug) {
          console.warn(`Found ${existingIndices.size} existing appIDs`);
        }
        appIds = appIds.filter((_, idx) => !existingIndices.has(idx));
      }
    }

    if (!appIds.length) return [];

    const perTxn = 7;
    const groupChunks = chunk(appIds, perTxn * 15);
    if (debug)
      console.debug(
        `Starting registration for ${appIds.length} appIds${skipCheck ? " with skipCheck" : ""}${perTxn ? ` and perGroup ${perTxn}` : ""}${passIdx > 1 ? ` on pass ${passIdx}` : ""}`,
      );

    if (debug) console.debug(`Doing ${appIds.length} in ${groupChunks.length} chunks with concurrency ${concurrency}`);

    const senderBoxRef = creditBoxRef(Address.fromString(this.writerAccount!.addr.toString()).publicKey);

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
            const boxReferences = [senderBoxRef, ...appIds.map((appId) => getApplicationAddress(appId).publicKey.slice(0, 4))];
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
          const transformed = await errorTransformer(e as Error);
          if (debug) {
            console.error(`Chunk ${chunkIdx}/${groupChunks.length} failed with error:`, transformed);
            console.debug(`Failed chunk appIds: ${groupChunk.join(" ")}`);
          }
          thisPassFails += groupChunk.length;
          failedAppIds.push(...groupChunk);
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

  /**
   * Look up app IDs for the given app escrow addresses. Uses simulate to read contract state
   * without requiring a signer. Returns 0 (mapped to undefined) for addresses not found.
   *
   * @param addresses - Array of Algorand addresses to look up.
   * @param concurrency - Number of simulate calls to run in parallel.
   * @param debug - Enable debug logging.
   * @returns Map of address to app ID, or undefined if not registered.
   */
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

  /**
   * Delete app registry boxes by their 4-byte keys. Admin only.
   *
   * @param boxKeys - Array of 4-byte box keys to delete.
   * @param debug - Enable debug logging.
   * @param concurrency - Number of transaction groups to send in parallel.
   * @returns Array of transaction IDs.
   * @throws If writer account is not set, or if sender is not the admin (ERR:AUTH).
   */
  async deleteBoxes({
    boxKeys,
    debug,
    concurrency = 1,
  }: {
    boxKeys: Uint8Array[];
    debug?: boolean;
    concurrency?: number;
  }): Promise<string[]> {
    return wrapErrorsInternal(async () => {
      if (!this.writerAccount) throw new Error("Write operation requested without writer account");

      if (!boxKeys.length) return [];

      const perTxn = 8;
      const groupChunks = chunk(boxKeys, perTxn * 15);

      if (debug) console.debug(`Deleting ${boxKeys.length} boxes in ${groupChunks.length} chunks with concurrency ${concurrency}`);

      const results = await pMap(
        groupChunks,
        async (groupChunk, chunkIdx) => {
          if (debug) console.debug(`Starting chunk ${chunkIdx + 1}/${groupChunks.length} (${groupChunk.length} keys)`);

          const keyChunks = chunk(groupChunk, perTxn);

          const addDeleteBoxesCalls = (builder: EscregComposer<any>) => {
            for (const keys of keyChunks) {
              builder = builder.deleteBoxes({ args: { boxKeys: keys }, boxReferences: keys });
            }
            return builder;
          };

          let group = addDeleteBoxesCalls(this.client.newGroup());

          const increasedBuilder = await getIncreaseBudgetBuilder(
            group,
            () => this.client.newGroup(),
            this.writerAccount!.addr.toString(),
            this.writerAccount!.signer,
            this.algorand.client.algod,
          );

          if (increasedBuilder) {
            group = addDeleteBoxesCalls(increasedBuilder);
          }

          const composer = await group.composer();
          const { transactions } = await composer.build();
          const txns = transactions.map(({ txn }) => txn);
          const signed = await transactions[0].signer(
            txns,
            txns.map((_, i) => i),
          );

          await this.algorand.client.algod.sendRawTransaction(signed).do();
          await waitForConfirmation(this.algorand.client.algod, txns[0].txID(), 8);

          return txns.map((t) => t.txID());
        },
        { concurrency },
      );

      return results.flat();
    });
  }

  /**
   * Deposit MBR credits for an account. Sends a payment to the contract and credits the specified account.
   * Credits are used to cover box MBR costs when registering app IDs.
   *
   * @param creditor - Address of the account to credit.
   * @param amount - Amount of microAlgos to deposit as credits.
   * @param debug - Enable debug logging.
   * @returns Transaction ID of the deposit.
   * @throws If writer account is not set, or if the payment amount is 0 (ERR:AMT).
   */
  async depositCredit({ creditor, amount, debug }: { creditor: string; amount: bigint; debug?: boolean }): Promise<string> {
    return wrapErrorsInternal(async () => {
      if (!this.writerAccount) throw new Error("Write operation requested without writer account");

      if (debug) {
        console.debug(`Depositing ${amount.toString()} microAlgos for ${creditor}`);
      }

      const appAddress = getApplicationAddress(this.appId).toString();
      const payTxn = await this.algorand.createTransaction.payment({
        sender: this.writerAccount.addr.toString(),
        receiver: appAddress,
        amount: amount.microAlgo(),
      });

      const boxRef = creditBoxRef(Address.fromString(creditor).publicKey);

      const { confirmation } = await this.client.send.depositCredits({
        args: { creditor, txn: payTxn },
        boxReferences: [boxRef],
        sender: this.writerAccount.addr.toString(),
        signer: this.writerAccount.signer,
      });

      if (debug) {
        console.debug(`Deposit successful. Transaction ID: ${confirmation.txn.txn.txID()}`);
      }

      return confirmation.txn.txn.txID();
    });
  }

  /**
   * Withdraw all remaining MBR credits for the sender. Deletes the user credit box,
   * so all credits are withdrawn including the MBR locked for the credit box itself.
   *
   * @param debug - Enable debug logging.
   * @returns Transaction ID of the withdrawal.
   * @throws If writer account is not set, or if sender has no credit box (ERR:AMT).
   */
  async withdrawCredit({ debug }: { debug?: boolean } = {}): Promise<string> {
    return wrapErrorsInternal(async () => {
      if (!this.writerAccount) throw new Error("Write operation requested without writer account");

      const sender = this.writerAccount.addr.toString();
      const boxRef = creditBoxRef(Address.fromString(sender).publicKey);

      if (debug) {
        console.debug(`Withdrawing all credits for ${sender}`);
      }

      const { confirmation } = await this.client.send.withdrawCredits({
        args: {},
        boxReferences: [boxRef],
        extraFee: (1000).microAlgo(),
        sender,
        signer: this.writerAccount.signer,
      });

      if (debug) {
        console.debug(`Credit withdrawal successful. Transaction ID: ${confirmation.txn.txn.txID()}`);
      }

      return confirmation.txn.txn.txID();
    });
  }

  /**
   * Withdraw funds from the contract to the admin. Admin only.
   *
   * @param amount - Amount of microAlgos to withdraw.
   * @param debug - Enable debug logging.
   * @returns Transaction ID of the withdrawal.
   * @throws If writer account is not set, or if sender is not the admin (ERR:AUTH).
   */
  async withdraw({ amount, debug }: { amount: bigint; debug?: boolean }): Promise<string> {
    return wrapErrorsInternal(async () => {
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
    });
  }

  // this requires full client, we are now using minimal client for bundle size reasons
  //
  // async destroyApp({
  //   debug,
  //   concurrency = 1,
  // }: {
  //   debug?: boolean;
  //   concurrency?: number;
  // } = {}): Promise<void> {
  //   return wrapErrorsInternal(async () => {
  //     if (!this.writerAccount) throw new Error("Write operation requested without writer account");

  //     const appId = Number(this.appId);
  //     const escrowAddress = getApplicationAddress(this.appId).toString();

  //     // 1. Get all box keys and delete them
  //     const { boxes } = await this.algorand.client.algod.getApplicationBoxes(appId).do();
  //     if (debug) console.debug(`Found ${boxes.length} boxes to delete`);

  //     if (boxes.length) {
  //       const boxKeys = boxes.map((b: { name: Uint8Array }) => b.name);
  //       await this.deleteBoxes({ boxKeys, debug, concurrency });
  //       if (debug) console.debug("All boxes deleted");
  //     }

  //     // 2. Withdraw all funds above the minimum balance
  //     let accountInfo = await this.algorand.client.algod.accountInformation(escrowAddress).do();
  //     let balance = BigInt(accountInfo.amount);
  //     let minBalance = BigInt(accountInfo.minBalance);
  //     let withdrawable = balance - minBalance;

  //     if (withdrawable > 0n) {
  //       await this.withdraw({ amount: withdrawable, debug });
  //       if (debug) console.debug(`Withdrew ${withdrawable} microAlgos`);
  //     }

  //     accountInfo = await this.algorand.client.algod.accountInformation(escrowAddress).do();
  //     if (accountInfo.minBalance > 100_000) {
  //       throw new Error(`Expected minimum balance to be 0.1, instead found ${accountInfo.minBalance}`)
  //     }

  //     // 3. Delete the application
  //     await this.client.send.deleteApplication({
  //       args: {},
  //       sender: this.writerAccount.addr.toString(),
  //       signer: this.writerAccount.signer,
  //     });
  //     if (debug) console.debug("Application deleted");
  //   });
  // }
}
