import {
  abimethod,
  BoxMap,
  Bytes,
  bytes,
  contract,
  GlobalState,
  itxn,
  OnCompleteAction,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { Address, ConventionalRouting } from '@algorandfoundation/algorand-typescript/arc4'
import { Global, sha512_256 } from '@algorandfoundation/algorand-typescript/op'
import { ensure } from '../common.algo'
import { MbrManager } from '../mbr-manager/contract.algo'
import { errAppNotRegistered, errAuth } from './errors.algo'

const RETURN_TRUE = Bytes.fromHex('0a8101') // #pragma version 10; pushint 1

export type AddressWithAuth = {
  appId: uint64
  authAppId: uint64
}

@contract({ stateTotals: { globalBytes: 32, globalUints: 32 } })
export class Escreg extends MbrManager implements ConventionalRouting {
  /** Contract admin */
  admin = GlobalState<Address>({ initialValue: new Address(Txn.sender) })
  /**
   * BoxMap from 4-byte prefix of escrow to app IDs.
   *
   * The value is a packed array of big-endian 8-byte app IDs with no length header, so the
   * bucket size is derived from the box length (`length / 8`). This saves the 2 bytes an ARC-4
   * dynamic array header would occupy - 800 microAlgos of MBR on every box - and lets lookups
   * read one candidate at a time instead of decoding the whole bucket.
   *
   * Buckets left over from the earlier ARC-4 `uint64[]` layout are still readable: see
   * `bucketHeaderLen`. Call `migrateBoxes` to convert them.
   */
  apps = BoxMap<bytes<4>, bytes>({ keyPrefix: '' })
  /** Counter for the number of registered applications */
  counter = GlobalState<uint64>({ initialValue: 0 })

  //
  // ------- ADMIN -------
  //

  /**
   * Delete the application.
   * @throws ERR:AUTH if sender is not the admin
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public deleteApplication() {
    this.adminOnly()
  }

  /**
   * Update the application.
   * @throws ERR:AUTH if sender is not the admin
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public updateApplication() {
    this.adminOnly()
  }

  /**
   * Withdraw funds from the contract to the admin.
   * @param amount Amount of microAlgos to withdraw.
   * @throws ERR:AUTH if sender is not the admin
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public withdraw(amount: uint64) {
    this.adminOnly()
    itxn
      .payment({
        receiver: Txn.sender,
        amount,
      })
      .submit()
  }

  /**
   * Delete app registry boxes by their keys.
   * @param boxKeys Array of 4-byte box keys to delete.
   * @throws ERR:AUTH if sender is not the admin
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public deleteBoxes(boxKeys: bytes<4>[]): void {
    this.adminOnly()
    for (const key of boxKeys) {
      if (this.apps(key).exists) {
        const size = this.apps(key).length
        this.counter.value -= (size - this.bucketHeaderLen(size)) / 8
        this.apps(key).delete()
      }
    }
  }

  /**
   * Convert app registry boxes still using the legacy ARC-4 `uint64[]` layout to the packed
   * layout, freeing the 800 microAlgos of MBR its 2-byte length header holds. Keys that do not
   * exist, or that are already packed, are skipped.
   *
   * The freed MBR is not credited back to any account - it stays in the contract balance and can
   * be recovered by the admin with `withdraw`.
   * @param boxKeys Array of 4-byte box keys to migrate.
   * @returns Number of boxes actually converted.
   * @throws ERR:AUTH if sender is not the admin
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public migrateBoxes(boxKeys: bytes<4>[]): uint64 {
    this.adminOnly()
    let migrated: uint64 = 0
    for (const key of boxKeys) {
      if (this.apps(key).exists) {
        const size = this.apps(key).length
        const headerLen = this.bucketHeaderLen(size)
        if (headerLen !== 0) {
          this.dropLegacyHeader(key, size, headerLen)
          migrated += 1
        }
      }
    }
    return migrated
  }

  /** Ensure the sender is the admin. @throws ERR:AUTH if sender is not the admin */
  protected adminOnly() {
    ensure(Txn.sender === this.admin.value.native, errAuth)
  }

  //
  // ------- PUBLIC -------
  //

  /**
   * Register a single application escrow account
   * @param appId App ID of the application to register. The app address derived from this ID will be registered in the contract and can be retrieved later.
   * @throws ERR:CRD if sender has insufficient credits to cover box MBR increase
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public register(appId: uint64): void {
    const mbrBefore = Global.currentApplicationAddress.minBalance

    const key = this.deriveAddrPrefix(appId)
    if (!this.apps(key).exists) {
      this.counter.value += 1
      this.apps(key).value = op.itob(appId)
    } else {
      this.appendAppId(key, appId)
    }

    this.manageMbrCredits(mbrBefore)
  }

  /**
   * Register multiple application escrow accounts in a single transaction. This is more efficient than calling register multiple times as the MBR cost can be paid for in a single payment and the app IDs can be stored more efficiently in the contract state.
   * @param appIds Array of App IDs to register. The app addresses derived from these IDs will be registered in the contract and can be retrieved later.
   * @throws ERR:CRD if sender has insufficient credits to cover box MBR increase
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public registerList(appIds: uint64[]): void {
    const mbrBefore = Global.currentApplicationAddress.minBalance

    for (const appId of appIds) {
      const key = this.deriveAddrPrefix(appId)
      if (!this.apps(key).exists) {
        this.counter.value += 1
        this.apps(key).value = op.itob(appId)
      } else {
        this.appendAppId(key, appId)
      }
    }

    this.manageMbrCredits(mbrBefore)
  }

  /**
   * Derive the 4-byte box key prefix for the given app ID by hashing its escrow address.
   * @param appId App ID to derive the prefix for.
   * @returns 4-byte prefix of the app escrow address hash.
   */
  private deriveAddrPrefix(appId: uint64): bytes<4> {
    return sha512_256(Bytes`appID`.concat(op.itob(appId)))
      .slice(0, 4)
      .toFixed({ strategy: 'unsafe-cast', length: 4 })
  }

  /**
   * Derive the full 32-byte app escrow address for the given app ID.
   * @param appId App ID to derive the escrow address for.
   * @returns 32-byte app escrow address.
   */
  private deriveAddr(appId: uint64): bytes<32> {
    return sha512_256(Bytes`appID`.concat(op.itob(appId)))
  }

  /**
   * Length of the leading length header in a bucket of the given size.
   *
   * Buckets written by this contract are packed 8-byte app IDs, so their size is 0 mod 8. Buckets
   * left over from the earlier ARC-4 `uint64[]` layout carry a 2-byte length header ahead of the
   * same 8-byte app IDs, so their size is 2 mod 8. The two layouts can never be confused, which
   * makes the remainder the header length and lets readers handle both without a version flag.
   * @param size Box size in bytes.
   * @returns 2 for a legacy bucket, 0 for a packed one.
   */
  private bucketHeaderLen(size: uint64): uint64 {
    return size % 8
  }

  /**
   * Rewrite a legacy bucket in place as a packed one, by shifting its app IDs over the length
   * header and trimming the freed bytes off the end.
   * @param key 4-byte box key to rewrite.
   * @param size Current box size.
   * @param headerLen Legacy header length, from `bucketHeaderLen`.
   */
  private dropLegacyHeader(key: bytes<4>, size: uint64, headerLen: uint64) {
    this.apps(key).splice(0, headerLen, Bytes(''))
    this.apps(key).resize(size - headerLen)
  }

  /**
   * Append an app ID to its corresponding box key, skipping if it already exists. Increments the counter on insert. Converts a legacy bucket to the packed layout on the way.
   * @param key 4-byte box key to append to.
   * @param appId App ID to append.
   */
  private appendAppId(key: bytes<4>, appId: uint64) {
    const size = this.apps(key).length
    const headerLen = this.bucketHeaderLen(size)
    const packedLen: uint64 = size - headerLen

    for (let i: uint64 = 0; i < packedLen / 8; i++) {
      if (op.btoi(this.apps(key).extract(headerLen + i * 8, 8)) === appId) {
        return
      }
    }

    if (headerLen !== 0) {
      this.dropLegacyHeader(key, size, headerLen)
    }
    this.apps(key).resize(packedLen + 8)
    this.apps(key).replace(packedLen, op.itob(appId))
    this.counter.value += 1
  }

  /**
   * Find the app ID whose escrow address matches the given address.
   * @param address Address to match against.
   * @param bucket Bucket bytes: one big-endian 8-byte app ID per candidate, after any legacy length header.
   * @returns The matching app ID, or 0 if no match is found.
   */
  private findAddr(address: Address, bucket: bytes): uint64 {
    const headerLen = this.bucketHeaderLen(bucket.length)
    const count: uint64 = (bucket.length - headerLen) / 8

    for (let i: uint64 = 0; i < count; i++) {
      const appId = op.extractUint64(bucket, headerLen + i * 8)
      if (address.native.bytes === this.deriveAddr(appId)) {
        return appId
      }
    }
    return 0
  }

  /**
   * Look up the app ID registered for an address by probing its 4-byte prefix bucket.
   * @param address Address to look up.
   * @returns The matching app ID, or 0 if there is no bucket for the prefix or it holds no match.
   */
  private lookup(address: Address): uint64 {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    const [bucket, bucketExists] = this.apps(addr4).maybe()
    if (!bucketExists) {
      return 0
    }

    return this.findAddr(address, bucket)
  }

  /**
   * Return true if an app escrow account exists for the given address, false otherwise.
   * @param address App Escrow to check
   * @returns boolean indicating whether the given address is registered in the contract
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public exists(address: Address): boolean {
    return this.lookup(address) !== 0
  }

  /**
   * Get the app ID for the given app escrow address. Returns 0 if the app escrow is not registered in the contract.
   * @param address App Escrow to get the app ID for
   * @returns App ID for the given address, or 0 if not registered
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public get(address: Address): uint64 {
    return this.lookup(address)
  }

  /**
   * Get the app ID for the given app escrow address. Throws an error if the app escrow is not registered in the contract.
   * @param address App Escrow to get the app ID for
   * @throws ERR:404 Error if the app escrow is not registered in the contract
   * @returns App ID for the given address
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public mustGet(address: Address): uint64 {
    const matchingAppID = this.lookup(address)

    ensure(matchingAppID !== 0, errAppNotRegistered)

    return matchingAppID
  }

  /**
   * Get the app ID for the given app escrow address and its auth address. Returns 0 for each if not registered in the contract.
   * @param address App Escrow to get the app ID for, along with its auth address
   * @returns [app ID for the given address, app ID for the auth address], or 0 for each if not registered
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public getWithAuth(address: Address): AddressWithAuth {
    const appId = this.lookup(address)
    const authAppId = this.lookup(new Address(address.native.authAddress))

    return { appId, authAppId }
  }

  /**
   * Get the app ID for multiple app escrow addresses and their auth addresses. Returns 0 for each if not registered in the contract.
   * @param addresses App Escrows to get the app IDs for, along with their auth addresses
   * @returns Array of [app ID for the given address, app ID for the auth address] for each input address, or 0 for each if not registered
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public getWithAuthList(addresses: Address[]): AddressWithAuth[] {
    let results: AddressWithAuth[] = []

    for (const address of addresses) {
      const appId = this.lookup(address)
      const authAppId = this.lookup(new Address(address.native.authAddress))

      results.push({ appId, authAppId })
    }

    return results
  }

  /**
   * Get the app IDs for multiple app escrow addresses. Returns 0 for each if not registered in the contract.
   * @param addresses App Escrows to get the app IDs for
   * @returns Array of app IDs for each input address, or 0 if not registered
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public getList(addresses: Address[]): uint64[] {
    let apps: uint64[] = []

    for (const address of addresses) {
      apps = [...apps, this.lookup(address)]
    }
    return apps
  }

  /**
   * Get the app IDs for multiple app escrow addresses. Throws an error if any of the app escrows are not registered in the contract.
   * @param addresses App Escrows to get the app IDs for
   * @returns Array of app IDs for each input address
   * @throws ERR:404 Error if any of the app escrows are not registered in the contract
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public mustGetList(addresses: Address[]): uint64[] {
    let apps: uint64[] = []
    for (const address of addresses) {
      const matchingAppID = this.lookup(address)

      ensure(matchingAppID !== 0, errAppNotRegistered)
      apps = [...apps, matchingAppID]
    }
    return apps
  }

  /**
   * Utility for explicitly increasing the budget of a transaction group by performing no-op inner transactions.
   * @param itxns Number of itxns to perform.
   */
  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public increaseBudget(itxns: uint64) {
    for (let i: uint64 = 0; i < itxns; i++) {
      itxn
        .applicationCall({
          approvalProgram: RETURN_TRUE,
          clearStateProgram: RETURN_TRUE,
          onCompletion: OnCompleteAction.DeleteApplication,
          fee: 0,
        })
        .submit()
    }
  }
}
