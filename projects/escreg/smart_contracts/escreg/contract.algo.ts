import {
  abimethod,
  assert,
  BoxMap,
  Bytes,
  bytes,
  Contract,
  err,
  log,
  op,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import { Address } from '@algorandfoundation/algorand-typescript/arc4'
import { Global, sha512_256 } from '@algorandfoundation/algorand-typescript/op'

const ERR_APP_NOT_REGISTERED = 'App not registered'

export class Escreg extends Contract {
  apps = BoxMap<bytes<4>, uint64[]>({ keyPrefix: '' })

  public register(appId: uint64): void {
    const key = this.deriveAddrPrefix(appId)
    if (!this.apps(key).exists) {
      this.apps(key).value = [appId]
    } else {
      this.appendAppId(key, appId)
    }
  }

  public registerList(appIds: uint64[]): void {
    for (const appId of appIds) {
      const key = this.deriveAddrPrefix(appId)
      if (!this.apps(key).exists) {
        this.apps(key).value = [appId]
      } else {
        this.appendAppId(key, appId)
      }
    }
    log(Global.opcodeBudget)
  }

  private deriveAddrPrefix(appId: uint64): bytes<4> {
    return sha512_256(Bytes`appID`.concat(op.itob(appId)))
      .slice(0, 4)
      .toFixed({ length: 4 })
  }

  private deriveAddr(appId: uint64): bytes<32> {
    return sha512_256(Bytes`appID`.concat(op.itob(appId)))
  }

  private appendAppId(key: bytes<4>, appId: uint64) {
    const existing = this.apps(key).value as Readonly<uint64[]>
    for (const existingId of existing) {
      if (existingId === appId) {
        log('ERR:EXISTS')
        err('ERR:EXISTS')
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

  @abimethod({ readonly: true })
  public exists(address: Address): boolean {
    const addr4 = address.bytes.slice(0, 4).toFixed({ length: 4 })

    if (!this.apps(addr4).exists) {
      return false
    }

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findMatch(address, apps)

    return matchingAppID !== 0
  }

  @abimethod({ readonly: true })
  public get(address: Address): uint64 {
    const addr4 = address.bytes.slice(0, 4).toFixed({ length: 4 })

    if (!this.apps(addr4).exists) {
      return 0
    }

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findMatch(address, apps)

    return matchingAppID
  }

  @abimethod({ readonly: true })
  public mustGet(address: Address): uint64 {
    const addr4 = address.bytes.slice(0, 4).toFixed({ length: 4 })

    assert(this.apps(addr4).exists, ERR_APP_NOT_REGISTERED)

    const apps = this.apps(addr4).value as Readonly<uint64[]>
    const matchingAppID = this.findMatch(address, apps)

    assert(matchingAppID !== 0, ERR_APP_NOT_REGISTERED)

    return matchingAppID
  }

  @abimethod({ readonly: true })
  public getList(addresses: Address[]): uint64[] {
    let apps: uint64[] = []
    const zero: uint64 = 0
    for (const address of addresses) {
      const addr4 = address.bytes.slice(0, 4).toFixed({ length: 4 })

      if (!this.apps(addr4).exists) {
        apps = [...apps, zero]
        continue
      }

      const appList = this.apps(addr4).value as Readonly<uint64[]>
      apps = [...apps, this.findMatch(address, appList)]
    }
    return apps
  }

  @abimethod({ readonly: true })
  public mustGetList(addresses: Address[]): uint64[] {
    let apps: uint64[] = []
    for (const address of addresses) {
      const addr4 = address.bytes.slice(0, 4).toFixed({ length: 4 })

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
