import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { Account, Address, getApplicationAddress } from 'algosdk'
import { EscregSDK } from 'escreg-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
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
})
