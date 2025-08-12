import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { Account, Address, getApplicationAddress } from 'algosdk'
import { EscregSDK } from 'escreg-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { EscregFactory } from '../../artifacts/escreg/EscregClient'
import { brange, chunk } from './util'

describe('Escreg SDK', () => {
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

    const appId = 1002n
    const address = getApplicationAddress(appId).toString()

    console.log({ reg: 1 })
    await sdk.register({ appIds: [appId] })
    console.log({ reg: 2 })
    const actual = await sdk.lookup({ addresses: [address] })

    expect(actual).toEqual({ [address]: 1002n })
  })

  test('registers 112x', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    const start = 1003
    const appIds = brange(start, start + 112 - 1)

    await sdk.register({ appIds })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const actual = await sdk.lookup({ addresses })
    const expected = Object.fromEntries(appIds.map((appId) => [getApplicationAddress(appId), appId]))

    expect(actual).toEqual(expected)
  })

  test('lookup 128x', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    let start = 1003
    const appIds = brange(start, start + 128 - 1)

    const chunks = chunk(appIds, 112)
    await Promise.all(chunks.map(appIds => sdk.register({ appIds })))

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const actual = await sdk.lookup({ addresses })
    const expected = Object.fromEntries(appIds.map((appId) => [getApplicationAddress(appId), appId]))

    expect(actual).toEqual(expected)
  })

  // test('getList returns 0 for not found', async () => {
  //   const { testAccount } = localnet.context
  //   const { client } = await deploy(testAccount)

  //   const appIds = range(1003, 1005)

  //   await client.send.registerList({ args: { appIds } })

  //   const expected = [0, 1003, 0, 1004, 0]

  //   const [app1003, app1004] = appIds.map((appId) => getApplicationAddress(appId).toString())
  //   const notFound = getApplicationAddress(1002).toString()

  //   const { return: results } = await client.send.getList({
  //     args: { addresses: [notFound, app1003, notFound, app1004, notFound] },
  //   })

  //   for (let i = 0; i < appIds.length; i++) {
  //     expect(results![i]).toBe(BigInt(expected[i]))
  //   }

  //   const address = getApplicationAddress(1002).toString()
  //   const { return: result } = await client.send.get({ args: { address } })

  //   expect(result).toBe(0n)
  // })

  // test('getWithAuth', async () => {})
})
