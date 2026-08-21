import {
  Algodv2,
  AtomicTransactionComposer,
  makeApplicationCallTxnFromObject,
  modelsv2,
  OnApplicationComplete,
  ResourceReference,
  SuggestedParams,
} from "algosdk";
import {
  ADDRESSES_PER_CALL,
  ADDRESSES_PER_CALL_LEGACY,
  DEFAULT_ADDRESSES_PER_GROUP,
  DEFAULT_APP_ID,
  DEFAULT_READER_ACCOUNT,
  FNET_ALGOD_PORT,
  FNET_ALGOD_SERVER,
  LOOKUP_CALL_FEE,
  LOOKUP_OPCODE_BUDGET,
  MAX_BOXES_PER_GROUP_NAMED,
  MAX_BOXES_PER_GROUP_UNNAMED,
  REFS_PER_ACCESS_LIST,
  SUGGESTED_PARAMS_CACHE_MS,
  TXNS_PER_GROUP,
  unnamedAddressesPerGroup,
} from "./constants.js";
import {
  chunk,
  decodeAppIds,
  distinctBoxKeys,
  emptySigner,
  encodeAddresses,
  getListMethod,
  isArgTooLongError,
  isBoxRefError,
  mapConcurrent,
} from "./util.js";
import { AlgodProvider, LookupResult } from "./types.js";

/**
 * The lookup half of the SDK: everything needed to resolve addresses to app IDs, and nothing else.
 *
 * This entry point depends on algosdk alone - no algokit-utils, no generated client, no app spec -
 * because looking escrows up is what most consumers ship to a browser. Import
 * `@d13co/escreg-sdk/full` for registration, credits, the registry scan, and the admin methods; its
 * `EscregSDK` extends this one, so everything here is available there too.
 */

export { boxCursor, decodeBucket } from "./util.js";
export type { AlgodProvider, BucketPage, CreditResult, LookupResult, RegistryBucket, SizedBoxKey } from "./types.js";

/** Options every SDK instance takes. All of them are optional and default to the fnet deployment. */
export interface EscregLookupOptions {
  /** The Escreg application ID. */
  appId?: bigint;
  /** Algod client to read from. Ignored when `algorand` is given. */
  algod?: Algodv2;
  /** An algokit-utils `AlgorandClient`, or anything else carrying an algod client. */
  algorand?: AlgodProvider;
  /** Address used as sender for read-only simulate calls. Defaults to the fee sink. */
  readerAccount?: string;
  /**
   * Addresses `lookup` resolves per simulate group, 1 to 256. Defaults to 256. Anything above 128
   * names the group's boxes in AVM 13 access lists, so it needs a node that supports them; drop it
   * to 127 or below for one round trip per `getList` call.
   */
  addressesPerGroup?: number;
}

/**
 * SDK for looking up Algorand addresses in the Escreg (Escrow Registry) contract.
 *
 * Lookups run through simulate against a read-only contract method, so they need no signer, no
 * funded account, and no write access of any kind.
 */
export class EscregSDK {
  /** The Escreg application ID. */
  public appId: bigint = DEFAULT_APP_ID;
  /** Algod client every read goes through. */
  public algod: Algodv2;
  /** The client the algod came from, when one was passed. Always set on the full SDK. */
  public algorand?: AlgodProvider;
  /** Address used as sender for read-only simulate calls. Defaults to fee sink, funded mostly everywhere. */
  public readerAccount = DEFAULT_READER_ACCOUNT;
  /** Addresses per `getList` call. Drops to the pre-AVM-13 size the first time a node rejects a full-size call. */
  public addressesPerCall = ADDRESSES_PER_CALL;
  /**
   * Addresses per simulate group, and so per round trip. Past 128 the group has to name its boxes in
   * access lists, which costs transactions - the addresses go into as few calls as they fit, and the
   * rest of the group's slots become carriers that name boxes and look nothing up. Worth it when the
   * round trip is expensive, not when it is cheap: measured against a public node it resolves a third
   * more addresses per second at concurrency 1, and against a local node it is slower.
   */
  public addressesPerGroup = DEFAULT_ADDRESSES_PER_GROUP;
  /** Whether this node has been seen to honour access lists. Cleared for good if one is rejected. */
  private namedBoxRefs = true;
  /** Suggested params and when they go stale. Every lookup group needs them; they change slowly. */
  private cachedParams?: { params: SuggestedParams; expires: number };

  /**
   * @param appId - The Escreg application ID.
   * @param algod - Algod client to read from. Ignored when `algorand` is given.
   * @param algorand - An algokit-utils `AlgorandClient`, or anything else carrying an algod client.
   * @param readerAccount - Address used as sender for read-only simulate calls. Defaults to the fee sink.
   * @param addressesPerGroup - Addresses `lookup` resolves per simulate group, 1 to 256. Defaults to
   *   256. Anything above 128 names the group's boxes in AVM 13 access lists, so it needs a node that
   *   supports them; drop it to 127 or below for one round trip per `getList` call.
   */
  constructor({ appId, algod, algorand, readerAccount, addressesPerGroup }: EscregLookupOptions = {}) {
    this.appId = appId ?? this.appId;
    this.algorand = algorand;
    this.algod = algorand?.client.algod ?? algod ?? new Algodv2("", FNET_ALGOD_SERVER, FNET_ALGOD_PORT);
    this.readerAccount = readerAccount ?? this.readerAccount;

    if (addressesPerGroup !== undefined) {
      if (!Number.isInteger(addressesPerGroup) || addressesPerGroup < 1 || addressesPerGroup > MAX_BOXES_PER_GROUP_NAMED) {
        throw new Error(`addressesPerGroup must be a whole number from 1 to ${MAX_BOXES_PER_GROUP_NAMED}, got ${addressesPerGroup}`);
      }
      this.addressesPerGroup = addressesPerGroup;
    }
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
    const perGroup = this.groupSize();
    const chunks = chunk(addresses, perGroup);
    const start = Date.now();

    if (debug) {
      console.debug(
        `Looking up ${addresses.length} addresses in ${chunks.length} chunks (${
          addresses.length <= perGroup ? addresses.length : `${perGroup} per chunk`
        }) with concurrency ${concurrency}`,
      );
    }

    // Process chunks in parallel
    const results = await mapConcurrent(
      chunks,
      async (addressesChunk, chunkIndex) => {
        // a group only needs access lists once it outgrows what simulate will work out on its own,
        // and naming boxes costs transactions, so the smaller groups stay on the cheaper path
        const named = this.namedBoxRefs && addressesChunk.length > MAX_BOXES_PER_GROUP_UNNAMED;
        const appIds = await this.simulateGroup(addressesChunk, named);

        const out: LookupResult = {};
        appIds.forEach((appId, i) => {
          out[addressesChunk[i]] = appId || undefined;
        });

        if (debug) {
          const found = Object.values(out).filter((appId) => appId !== undefined).length;
          console.debug(`Chunk ${chunkIndex + 1}/${chunks.length} completed: ${found}/${addressesChunk.length} addresses found`);
        }

        return out;
      },
      concurrency,
    ).catch((e) => {
      // An older node cannot do what was asked of it: it ignores or rejects the access lists, or -
      // predating AVM 13 entirely - caps the whole arg list at 2048 bytes and turns down a full-size
      // call before it runs. Give up the capability for good on this SDK and start over, so the
      // groups are rebuilt around what the node will take.
      if (this.namedBoxRefs && (isBoxRefError(e) || isArgTooLongError(e))) {
        console.warn(`escreg: node turned down a group with named box references, falling back to unnamed ones: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        this.namedBoxRefs = false;
        return undefined;
      }
      if (isArgTooLongError(e) && this.addressesPerCall !== ADDRESSES_PER_CALL_LEGACY) {
        console.warn(`escreg: node rejected a ${this.addressesPerCall}-address call, falling back to ${ADDRESSES_PER_CALL_LEGACY}`);
        this.addressesPerCall = ADDRESSES_PER_CALL_LEGACY;
        return undefined;
      }
      throw e;
    });

    if (!results) return this.lookup({ addresses, concurrency, debug });

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
   * Addresses to put in one simulate group: what the caller asked for, held down to what the node
   * and the current call size can actually carry.
   *
   * @returns Addresses per group.
   */
  private groupSize(): number {
    const ceiling = this.namedBoxRefs ? MAX_BOXES_PER_GROUP_NAMED : unnamedAddressesPerGroup(this.addressesPerCall);
    return Math.min(this.addressesPerGroup, ceiling);
  }

  /**
   * Suggested params for the lookup group's transactions, reused for a few minutes: simulate still
   * checks the validity window, but the window is a thousand rounds wide and nothing else in a
   * read-only call depends on them.
   *
   * @returns Suggested params from algod.
   */
  private async suggestedParams(): Promise<SuggestedParams> {
    if (this.cachedParams && this.cachedParams.expires > Date.now()) return this.cachedParams.params;
    const params = await this.algod.getTransactionParams().do();
    this.cachedParams = { params, expires: Date.now() + SUGGESTED_PARAMS_CACHE_MS };
    return params;
  }

  /**
   * Resolve one group of addresses through simulate.
   *
   * Unnamed, the group is one transaction per `getList` call and simulate works out which boxes they
   * touch - cheap, but it will only pool 128 boxes that way, which is the ceiling on how many
   * addresses such a group can carry.
   *
   * Named, every box the group reads is named in a transaction's access list, which doubles what a
   * round trip carries: 16 references per transaction over 16 transactions is 256 boxes, and the pool
   * is shared, so a call can read a box another transaction in the group named. The addresses go into
   * as few calls as the per-call cap allows; the group's remaining slots become carriers, which name
   * references and look nothing up.
   *
   * @param addresses - Addresses the group resolves.
   * @param named - Whether to name every box the group reads in an access list.
   * @returns App IDs in the order the addresses were given; 0 for an address that is not registered.
   */
  private async simulateGroup(addresses: string[], named: boolean): Promise<bigint[]> {
    const calls = chunk(addresses, this.addressesPerCall);
    const references = named ? chunk(distinctBoxKeys(addresses), REFS_PER_ACCESS_LIST) : [];
    const txns = Math.max(calls.length, references.length);
    if (txns > TXNS_PER_GROUP) {
      throw new Error(`${addresses.length} addresses need ${txns} transactions, more than a group's ${TXNS_PER_GROUP}`);
    }

    const suggestedParams = await this.suggestedParams();
    const atc = new AtomicTransactionComposer();

    for (let i = 0; i < txns; i++) {
      const access: ResourceReference[] | undefined = references[i]?.map((name) => ({ box: { appIndex: this.appId, name } }));
      atc.addTransaction({
        txn: makeApplicationCallTxnFromObject({
          sender: this.readerAccount,
          appIndex: this.appId,
          onComplete: OnApplicationComplete.NoOpOC,
          appArgs: [getListMethod.getSelector(), encodeAddresses(calls[i] ?? [])],
          access,
          suggestedParams: { ...suggestedParams, fee: BigInt(LOOKUP_CALL_FEE), flatFee: true },
        }),
        signer: emptySigner,
      });
    }

    const { simulateResponse } = await atc.simulate(
      this.algod,
      new modelsv2.SimulateRequest({
        txnGroups: [],
        allowEmptySignatures: true,
        allowMoreLogging: true,
        // the named group has already accounted for every box it reads
        allowUnnamedResources: !named,
        extraOpcodeBudget: LOOKUP_OPCODE_BUDGET,
      }),
    );

    const group = simulateResponse.txnGroups[0];
    // simulate reports a rejected group rather than throwing, so surface it as one
    if (group.failureMessage) throw new Error(group.failureMessage);

    // carriers return an empty array, so concatenating in transaction order is the input order
    return group.txnResults.flatMap(({ txnResult }) => decodeAppIds(txnResult.logs?.[(txnResult.logs?.length ?? 0) - 1]));
  }
}
