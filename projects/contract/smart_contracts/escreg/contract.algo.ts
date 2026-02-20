import {
  abimethod,
  assert,
  BoxMap,
  Bytes,
  bytes,
  Contract,
  GlobalState,
  itxn,
  OnCompleteAction,
  op,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { Address, ConventionalRouting } from '@algorandfoundation/algorand-typescript/arc4'
import { sha512_256 } from '@algorandfoundation/algorand-typescript/op'

const ERR_UNAUTH = 'ERR:UNAUTH'
const ERR_APP_NOT_REGISTERED = 'ERR:NOTFOUND'

export type AddressWithAuth = {
  appId: uint64
  authAppId: uint64
}

const RETURN_TRUE = Bytes.fromHex('0a8101') // #pragma version 10; pushint 1

export class Escreg extends Contract implements ConventionalRouting {
  apps = BoxMap<bytes<4>, uint64[]>({ keyPrefix: '' })
  admin = GlobalState<Address>({ initialValue: new Address(Txn.sender) })

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

  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public deleteApplication() {
    assert(Txn.sender === this.admin.value.native, ERR_UNAUTH)
  }

  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public updateApplication() {
    assert(Txn.sender === this.admin.value.native, ERR_UNAUTH)
  }

  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public withdraw(amount: uint64) {
    assert(Txn.sender === this.admin.value.native, ERR_UNAUTH)
    itxn
      .payment({
        receiver: Txn.sender,
        amount,
      })
      .submit()
  }

  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public register(appId: uint64): void {
    const key = this.deriveAddrPrefix(appId)
    if (!this.apps(key).exists) {
      this.apps(key).value = [appId]
    } else {
      this.appendAppId(key, appId)
    }
  }

  @abimethod({ validateEncoding: 'unsafe-disabled' })
  public registerList(appIds: uint64[]): void {
    for (const appId of appIds) {
      const key = this.deriveAddrPrefix(appId)
      if (!this.apps(key).exists) {
        this.apps(key).value = [appId]
      } else {
        this.appendAppId(key, appId)
      }
    }
  }

  private deriveAddrPrefix(appId: uint64): bytes<4> {
    return sha512_256(Bytes`appID`.concat(op.itob(appId)))
      .slice(0, 4)
      .toFixed({ strategy: 'unsafe-cast', length: 4 })
  }

  private deriveAddr(appId: uint64): bytes<32> {
    return sha512_256(Bytes`appID`.concat(op.itob(appId)))
  }

  private appendAppId(key: bytes<4>, appId: uint64) {
    const existing = this.apps(key).value as Readonly<uint64[]>
    for (const existingId of existing) {
      if (existingId === appId) {
        return
      }
    }
    this.apps(key).value = [...existing, appId]
  }

  private findMatch(address: Address, apps: Readonly<uint64[]>): uint64 {
    for (let i: uint64 = 0; i < apps.length; i++) {
      if (address.native.bytes === this.deriveAddr(apps[i])) {
        return apps[i]
      }
    }
    return 0
  }

  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public exists(address: Address): boolean {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    if (!this.apps(addr4).exists) {
      return false
    }

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findMatch(address, apps)

    return matchingAppID !== 0
  }

  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public get(address: Address): uint64 {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    if (!this.apps(addr4).exists) {
      return 0
    }

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findMatch(address, apps)

    return matchingAppID
  }

  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public mustGet(address: Address): uint64 {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    assert(this.apps(addr4).exists, ERR_APP_NOT_REGISTERED)

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findMatch(address, apps)

    assert(matchingAppID !== 0, ERR_APP_NOT_REGISTERED)

    return matchingAppID
  }

  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public getWithAuth(address: Address): AddressWithAuth {
    const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    let appId: uint64 = 0
    if (this.apps(addr4).exists) {
      const apps = this.apps(addr4).value as Readonly<uint64[]>
      appId = this.findMatch(address, apps)
    }

    const authAddr = address.native.authAddress
    const authAddr4 = authAddr.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

    let authAppId: uint64 = 0
    if (this.apps(authAddr4).exists) {
      const apps = this.apps(authAddr4).value as Readonly<uint64[]>
      authAppId = this.findMatch(new Address(authAddr), apps)
    }

    return { appId, authAppId }
  }

  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public getWithAuthList(addresses: Address[]): AddressWithAuth[] {
    let results: AddressWithAuth[] = []

    for (const address of addresses) {
      const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

      let appId: uint64 = 0
      if (this.apps(addr4).exists) {
        const apps = this.apps(addr4).value as Readonly<uint64[]>
        appId = this.findMatch(address, apps)
      }

      const authAddr = address.native.authAddress
      const authAddr4 = authAddr.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

      let authAppId: uint64 = 0
      if (this.apps(authAddr4).exists) {
        const apps = this.apps(authAddr4).value as Readonly<uint64[]>
        authAppId = this.findMatch(new Address(authAddr), apps)
      }

      results.push({ appId, authAppId })
    }

    return results
  }

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
      apps = [...apps, this.findMatch(address, appList)]
    }
    return apps
  }

  @abimethod({ readonly: true, validateEncoding: 'unsafe-disabled' })
  public mustGetList(addresses: Address[]): uint64[] {
    let apps: uint64[] = []
    for (const address of addresses) {
      const addr4 = address.bytes.slice(0, 4).toFixed({ strategy: 'unsafe-cast', length: 4 })

      if (!this.apps(addr4).exists) {
        assert(false, ERR_APP_NOT_REGISTERED)
      }

      const appList = this.apps(addr4).value as Readonly<uint64[]>
      const matchingAppID = this.findMatch(address, appList)

      assert(matchingAppID !== 0, ERR_APP_NOT_REGISTERED)
      apps = [...apps, matchingAppID]
    }
    return apps
  }
}
