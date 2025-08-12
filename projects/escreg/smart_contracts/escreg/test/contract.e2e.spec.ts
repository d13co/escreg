import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { EscregFactory } from '../../artifacts/escreg/EscregClient'
import { range } from './util'

describe('Escreg contract', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
      // traceAll: true,
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
    await expect(client.send.register({ args: { appId: 1002 } })).rejects.toThrow(/ERR:/)
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
    await expect(client.send.mustGet({ args: { address } })).rejects.toThrow(/App not registered/)
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
    await expect(client.send.mustGet({ args: { address } })).rejects.toThrow(/App not registered/)
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
})
