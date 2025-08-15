import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address, decodeUint64, encodeUint64, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { EscregFactory } from '../../artifacts/escreg/EscregClient'
import { TestParentFactory } from '../../artifacts/escreg/TestParentClient'
import { range } from './util'

describe('Escreg contract', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  const deploy = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(EscregFactory, {
      defaultSender: account,
    })

    const { appClient } = await factory.deploy({
      onUpdate: 'append',
      onSchemaBreak: 'append',
    })

    await localnet.algorand.send.payment({
      sender: account,
      receiver: appClient.appAddress,
      amount: (1).algos(),
    })

    return { client: appClient }
  }

  const deployTestParent = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(TestParentFactory, {
      defaultSender: account,
    })

    const { appClient } = await factory.deploy({
      onUpdate: 'append',
      onSchemaBreak: 'append',
    })

    await localnet.algorand.send.payment({
      sender: account,
      receiver: appClient.appAddress,
      amount: (1).algos(),
    })

    await appClient.send.spawn({ extraFee: (3000).microAlgo(), args: {} })

    return { client: appClient }
  }

  test('register 1002', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await client.send.register({ args: { appId: 1002 } })

    const address = getApplicationAddress(1002).toString()
    const { return: actual } = await client.send.get({ args: { address } })

    expect(actual).toBe(1002n)
  })

  test('registerList 1003-1004', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const appIds = range(1003, 1004)

    await client.send.registerList({ args: { appIds } })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const { return: results } = await client.send.getList({ args: { addresses } })

    for (let i = 0; i < appIds.length; i++) {
      expect(results![i]).toBe(BigInt(appIds[i]))
    }
  })

  for (let i = 1; i <= 10; i++) {
    test(`opcode budget register colliding x${i}`, async () => {
      const { testAccount } = localnet.context
      const { client } = await deploy(testAccount)

      const appIds = makeCollidingAppIDs(i)

      const {
        simulateResponse: {
          txnGroups: [{ appBudgetConsumed }],
        },
      } = await client.newGroup().registerList({ args: { appIds } }).simulate({
        extraOpcodeBudget: 170_000,
        allowUnnamedResources: true,
      })
      console.log('rrregister', appIds.length, appBudgetConsumed)
      // rrregister 1 122
      // rrregister 2 266
      // rrregister 3 356
      // rrregister 4 500
      // rrregister 5 590
      // rrregister 6 734
      // rrregister 7 824
      // rrregister 8 968
      // rrregister 9 1058
      // rrregister 10 1202

      // base: 32
      // non colliding: +90
      // colliding: +144
    })

    test(`opcode budget internal colliding x${i}`, async () => {
      const { testAccount } = localnet.context
      const { client } = await deploy(testAccount)

      const appIds = makeCollidingAppIDs(i)

      const {
        confirmations: [{ logs }],
        simulateResponse: {
          txnGroups: [{ appBudgetConsumed }],
        },
      } = await client.newGroup().registerList({ args: { appIds } }).simulate({
        extraOpcodeBudget: 170_000,
        allowUnnamedResources: true,
      })

      console.log({ logs })
      for(let j=0; j<(logs ?? []).length; j+=2) {
        const start = decodeUint64(logs ? logs[j] : Buffer.from([2**53]))
        const end = decodeUint64(logs ? logs[j+1] : Buffer.from([2**53]))
        const loopCost = start-end
        console.log('rrregister', i, j, loopCost)
      }
    })
  }

  test('registers 1003-1009', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const appIds = range(1003, 1009)

    await client.send.registerList({ args: { appIds } })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const { return: results } = await client.send.getList({ args: { addresses } })

    for (let i = 0; i < appIds.length; i++) {
      expect(results![i]).toBe(BigInt(appIds[i]))
    }
  })

  test('registers 1003-1009', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const appIds = range(1003, 1009)

    await client.send.registerList({ args: { appIds } })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const { return: results } = await client.send.getList({ args: { addresses } })

    for (let i = 0; i < appIds.length; i++) {
      expect(results![i]).toBe(BigInt(appIds[i]))
    }
  })

  test('register 1002 twice fails', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await client.send.register({ args: { appId: 1002 } })
    await expect(client.send.register({ args: { appId: 1002 } })).rejects.toThrow(/ERR:EXISTS/)
  })

  test('get returns 0 for not found', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const address = getApplicationAddress(1002).toString()
    const { return: result } = await client.send.get({ args: { address } })

    expect(result).toBe(0n)
  })

  test('mustGet throws for not found', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const address = getApplicationAddress(1002).toString()
    await expect(client.send.mustGet({ args: { address } })).rejects.toThrow(/ERR:NOTFOUND/)
  })

  test('getList returns 0 for not found', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const appIds = range(1003, 1005)

    await client.send.registerList({ args: { appIds } })

    const expected = [0, 1003, 0, 1004, 0]

    const [app1003, app1004] = appIds.map((appId) => getApplicationAddress(appId).toString())
    const notFound = getApplicationAddress(1002).toString()

    const { return: results } = await client.send.getList({
      args: { addresses: [notFound, app1003, notFound, app1004, notFound] },
    })

    for (let i = 0; i < appIds.length; i++) {
      expect(results![i]).toBe(BigInt(expected[i]))
    }

    const address = getApplicationAddress(1002).toString()
    const { return: result } = await client.send.get({ args: { address } })

    expect(result).toBe(0n)
  })

  test('mustGetList throws for not found', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const address = getApplicationAddress(1002).toString()
    await expect(client.send.mustGet({ args: { address } })).rejects.toThrow(/ERR:NOTFOUND/)
  })

  test('exists returns true for existing', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await client.send.register({ args: { appId: 1002 } })

    const address = getApplicationAddress(1002).toString()

    const { return: actual } = await client.send.exists({ args: { address } })

    expect(actual).toBe(true)
  })

  test('exists returns false for non-existing', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const address = getApplicationAddress(1002).toString()

    const { return: actual } = await client.send.exists({ args: { address } })

    expect(actual).toBe(false)
  })

  test('getWithAuth', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const {
      client: { appId: authAppId },
    } = await deployTestParent(testAccount)

    const appId = authAppId + 3n
    await client.send.registerList({ args: { appIds: [authAppId, appId] } })

    const address = getApplicationAddress(authAppId + 3n).toString()
    const { return: result } = await client.send.getWithAuth({ args: { address } })

    expect(result).toEqual({ appId, authAppId })
  })
})

function makeCollidingAppIDs(len: number) {
  return [
    2744314563, 2870264260, 1170497781, 3051682051, 2986105595, 3146317774, 1017298967, 3098880338, 2147488012,
    2332511508,
  ].slice(0, len)
}
