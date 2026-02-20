import {
  abimethod,
  BoxMap,
  Bytes,
  bytes,
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

export class Escreg extends MbrManager implements ConventionalRouting {
  /** Contract admin */
  admin = GlobalState<Address>({ initialValue: new Address(Txn.sender) })
  /** BoxMap from 4-byte prefix of escrow to app IDs */
  apps = BoxMap<bytes<4>, uint64[]>({ keyPrefix: '' })
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
        const apps = this.apps(key).value as Readonly<uint64[]>
        this.counter.value -= apps.length
        this.apps(key).delete()
      }
    }
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
      this.apps(key).value = [appId]
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
        this.apps(key).value = [appId]
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
   * Append an app ID to its corresponding box key, skipping if it already exists. Increments the counter on insert.
   * @param key 4-byte box key to append to.
   * @param appId App ID to append.
   */
  private appendAppId(key: bytes<4>, appId: uint64) {
    const existing = this.apps(key).value as Readonly<uint64[]>
    for (const existingId of existing) {
      if (existingId === appId) {
        return
      }
    }
    this.apps(key).value = [...existing, appId]
    this.counter.value += 1
  }

  /**
   * Find the app ID whose escrow address matches the given address.
   * @param address Address to match against.
   * @param apps Candidate app IDs to check.
   * @returns The matching app ID, or 0 if no match is found.
   */
  private findAddr(address: Address, apps: Readonly<uint64[]>): uint64 {
    for (let i: uint64 = 0; i < apps.length; i++) {
      if (address.native.bytes === this.deriveAddr(apps[i])) {
        return apps[i]
      }
    }
    return 0
  }

  /**
   * Return true if an app escrow account exists for the given address, false otherwise.
   * @param address App Escrow to check
   * @returns boolean indicating whether the given address is registered in the contract
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public exists(address: Address): boolean {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    if (!this.apps(addr4).exists) {
      return false
    }

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findAddr(address, apps)

    return matchingAppID !== 0
  }

  /**
   * Get the app ID for the given app escrow address. Returns 0 if the app escrow is not registered in the contract.
   * @param address App Escrow to get the app ID for
   * @returns App ID for the given address, or 0 if not registered
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public get(address: Address): uint64 {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    if (!this.apps(addr4).exists) {
      return 0
    }

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findAddr(address, apps)

    return matchingAppID
  }

  /**
   * Get the app ID for the given app escrow address. Throws an error if the app escrow is not registered in the contract.
   * @param address App Escrow to get the app ID for
   * @throws ERR:404 Error if the app escrow is not registered in the contract
   * @returns App ID for the given address
   */
  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public mustGet(address: Address): uint64 {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    ensure(this.apps(addr4).exists, errAppNotRegistered)

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findAddr(address, apps)

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
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    let appId: uint64 = 0
    if (this.apps(addr4).exists) {
      const apps = this.apps(addr4).value as Readonly<uint64[]>
      appId = this.findAddr(address, apps)
    }

    const authAddr = address.native.authAddress
    const authAddr4 = authAddr.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    let authAppId: uint64 = 0
    if (this.apps(authAddr4).exists) {
      const apps = this.apps(authAddr4).value as Readonly<uint64[]>
      authAppId = this.findAddr(new Address(authAddr), apps)
    }

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
      const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

      let appId: uint64 = 0
      if (this.apps(addr4).exists) {
        const apps = this.apps(addr4).value as Readonly<uint64[]>
        appId = this.findAddr(address, apps)
      }

      const authAddr = address.native.authAddress
      const authAddr4 = authAddr.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

      let authAppId: uint64 = 0
      if (this.apps(authAddr4).exists) {
        const apps = this.apps(authAddr4).value as Readonly<uint64[]>
        authAppId = this.findAddr(new Address(authAddr), apps)
      }

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
    const zero: uint64 = 0

    for (const address of addresses) {
      const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

      if (!this.apps(addr4).exists) {
        apps = [...apps, zero]
        continue
      }

      const appList = this.apps(addr4).value as Readonly<uint64[]>
      apps = [...apps, this.findAddr(address, appList)]
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
      const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

      if (!this.apps(addr4).exists) {
        ensure(false, errAppNotRegistered)
      }

      const appList = this.apps(addr4).value as Readonly<uint64[]>
      const matchingAppID = this.findAddr(address, appList)

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
