import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { Account, Address, getApplicationAddress } from 'algosdk'
import { boxCursor, EscregSDK } from '@d13co/escreg-sdk'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { EscregFactory } from '../../artifacts/escreg/EscregClient'
import { brange } from './util'
import { getCollidingAppIDs } from './fixtures'

describe('Escreg SDK - Registration & Lookup', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)
  afterEach(() => vi.restoreAllMocks())

  const deploy = async (account: Address & TransactionSignerAccount & Account) => {
    const factory = localnet.algorand.client.getTypedAppFactory(EscregFactory, {
      defaultSender: account,
    })

    const { appClient: client } = await factory.deploy({
      onUpdate: 'append',
      onSchemaBreak: 'append',
    })

    await localnet.algorand.account.ensureFundedFromEnvironment(client.appAddress, (10).algos())

    const sdk = new EscregSDK({ algorand: localnet.algorand, appId: client.appId, writerAccount: account })

    return { client: client, sdk }
  }

  test('register 1002', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()
    await sdk.depositCredit({ creditor, amount: 100_000n })

    const appId = 1002n
    const address = getApplicationAddress(appId).toString()

    await sdk.register({ appIds: [appId] })
    const actual = await sdk.lookup({ addresses: [address] })

    expect(actual).toEqual({ [address]: 1002n })
  })

  test('registers 128x', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()
    await sdk.depositCredit({ creditor, amount: 1_500_000n })

    const start = 1003
    const appIds = brange(start, start + 128 - 1)

    await sdk.register({ appIds })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const actual = await sdk.lookup({ addresses })
    const expected = Object.fromEntries(appIds.map((appId) => [getApplicationAddress(appId), appId]))

    expect(actual).toEqual(expected)
  })

  test('registers colliding', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()
    await sdk.depositCredit({ creditor, amount: 1_000_000n })

    const appIds = getCollidingAppIDs()

    await sdk.register({ appIds })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const actual = await sdk.lookup({ addresses })
    const expected = Object.fromEntries(appIds.map((appId) => [getApplicationAddress(appId), appId]))

    expect(actual).toEqual(expected)
  })

  test('lookup 128x', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()
    await sdk.depositCredit({ creditor, amount: 1_500_000n })

    let start = 1003
    const appIds = brange(start, start + 128 - 1)

    await sdk.register({ appIds })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const actual = await sdk.lookup({ addresses })
    const expected = Object.fromEntries(appIds.map((appId) => [getApplicationAddress(appId), appId]))

    expect(actual).toEqual(expected)
  })

  test('lookup 256x', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()
    await sdk.depositCredit({ creditor, amount: 3_000_000n })

    let start = 1003
    const appIds = brange(start, start + 256 - 1)

    await sdk.register({ appIds })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const actual = await sdk.lookup({ addresses })
    const expected = Object.fromEntries(appIds.map((appId) => [getApplicationAddress(appId), appId]))

    expect(actual).toEqual(expected)
  })

  test('a resumed scan refuses a cursor the node ignored', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    // a node predating the paginated listing answers with every box, cursor or not, which would hand
    // a resumed dump every row it has already written
    const first = new Uint8Array([1, 2, 3, 4])
    const boxes = [
      { name: first, value: new Uint8Array(8) },
      { name: new Uint8Array([5, 6, 7, 8]), value: new Uint8Array(8) },
    ]
    const listing: any = {
      limit: () => listing,
      include: () => listing,
      next: () => listing,
      do: async () => ({ boxes }),
    }
    vi.spyOn(localnet.algorand.client.algod, 'getApplicationBoxes').mockReturnValue(listing)

    await expect(sdk.scanBucketPages({ next: boxCursor(first) }).next()).rejects.toThrow(
      /ignored the box listing cursor/,
    )
    // the same listing is fine from the top, where there is nothing already dumped to skip past
    await expect(sdk.scanBucketPages().next()).resolves.toMatchObject({ value: { buckets: expect.any(Array) } })
  })
})
