import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { EscregClient, EscregFactory } from '../../artifacts/escreg/EscregClient'
import { TestParentFactory } from '../../artifacts/escreg/TestParentClient'
import { range } from './util'
import { getCollidingAppIDs } from './fixtures'

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

  const depositCredits = async (client: EscregClient, account: Address, amount: bigint) => {
    const appAddress = client.appAddress
    const payTxn = await localnet.algorand.createTransaction.payment({
      sender: account,
      receiver: appAddress,
      amount: amount.microAlgo(),
    })
    const boxRef = Address.fromString(account.toString()).publicKey
    await client.send.depositCredits({
      args: { creditor: account.toString(), txn: payTxn },
      boxReferences: [boxRef],
    })
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

    await depositCredits(client, testAccount, 100_000n)
    await client.send.register({ args: { appId: 1002 } })

    const address = getApplicationAddress(1002).toString()
    const { return: actual } = await client.send.get({ args: { address } })

    expect(actual).toBe(1002n)
  })


  test('register 1002 twice does not change box count', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)
    await client.send.register({ args: { appId: 1002 } })
    const { boxes: before } = await localnet.algorand.client.algod.getApplicationBoxes(Number(client.appId)).do()
    await client.send.register({ args: { appId: 1002 } })
    const { boxes: after } = await localnet.algorand.client.algod.getApplicationBoxes(Number(client.appId)).do()

    expect(before.length).toBe(after.length)
  })

  test('registerList 1003-1004', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)

    const appIds = range(1003, 1004)

    await client.send.registerList({ args: { appIds } })

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const { return: results } = await client.send.getList({ args: { addresses } })

    for (let i = 0; i < appIds.length; i++) {
      expect(results![i]).toBe(BigInt(appIds[i]))
    }
  })

  for (let i = 1; i <= 10; i++) {
    test(`opcode budget register noncolliding x${i}`, async () => {
      const { testAccount } = localnet.context
      const { client } = await deploy(testAccount)

      await depositCredits(client, testAccount, 1_000_000n)

      const appIds = new Array(i).fill(1).map((_, i) => 1002 + i)

      const {
        simulateResponse: {
          txnGroups: [{ appBudgetConsumed }],
        },
      } = await client.newGroup().registerList({ args: { appIds } }).simulate({
        extraOpcodeBudget: 170_000,
        allowUnnamedResources: true,
      })
      console.log('nrregister', appIds.length, appBudgetConsumed)
    })
  }

  for (let i = 1; i <= 10; i++) {
    test(`opcode budget register colliding x${i}`, async () => {
      const { testAccount } = localnet.context
      const { client } = await deploy(testAccount)

      await depositCredits(client, testAccount, 1_000_000n)

      const appIds = getCollidingAppIDs(i)

      const {
        simulateResponse: {
          txnGroups: [{ appBudgetConsumed }],
        },
      } = await client.newGroup().registerList({ args: { appIds } }).simulate({
        extraOpcodeBudget: 170_000,
        allowUnnamedResources: true,
      })
      console.log('crregister', appIds.length, appBudgetConsumed)
    })
  }

  for (let i = 0; i < 3; i++) {
    test(`increaseBudget opcode cost itxns=${i}`, async () => {
      const { testAccount } = localnet.context
      const { client } = await deploy(testAccount)

      const {
        simulateResponse: {
          txnGroups: [{ appBudgetConsumed }],
        },
      } = await client
        .newGroup()
        .increaseBudget({
          args: { itxns: i },
          extraFee: (i * 1000).microAlgo(),
        })
        .simulate()

      console.log(`increaseBudget itxns=${i} cost=${appBudgetConsumed}`)
      // Expected: baseCost + i * incrementCost
      // Update increaseBudgetBaseCost and increaseBudgetIncrementCost in SDK util.ts
    })
  }

  test('registers 1003-1009', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 500_000n)

    const appIds = range(1003, 1009)

    await client.newGroup()
      .increaseBudget({ args: { itxns: 1 }, extraFee: (1000).microAlgo() })
      .registerList({ args: { appIds } })
      .send()

    const addresses = appIds.map((appId) => getApplicationAddress(appId).toString())

    const { return: results } = await client.send.getList({ args: { addresses } })

    for (let i = 0; i < appIds.length; i++) {
      expect(results![i]).toBe(BigInt(appIds[i]))
    }
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
    await expect(client.send.mustGet({ args: { address } })).rejects.toThrow(/ERR:404/)
  })

  test('getList returns 0 for not found', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)

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
    await expect(client.send.mustGet({ args: { address } })).rejects.toThrow(/ERR:404/)
  })

  test('exists returns true for existing', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)
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
    await depositCredits(client, testAccount, 100_000n)
    await client.send.registerList({ args: { appIds: [authAppId, appId] } })

    const address = getApplicationAddress(authAppId + 3n).toString()
    const { return: result } = await client.send.getWithAuth({ args: { address } })

    expect(result).toEqual({ appId, authAppId })
  })

  test('register fails with insufficient credits (ERR:CRD)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    // Deposit just enough for the credit box itself (18900) but not enough for an app box
    await depositCredits(client, testAccount, 18_900n)

    await expect(
      client.send.register({ args: { appId: 1002 } }),
    ).rejects.toThrow(/ERR:CRD/)
  })

  test('deleteBoxes fails for non-admin (ERR:AUTH)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const otherAccount = await localnet.algorand.account.random()
    await localnet.algorand.account.ensureFundedFromEnvironment(otherAccount.addr, (10).algos())

    await expect(
      client.send.deleteBoxes({
        args: { boxKeys: [] },
        sender: otherAccount.addr.toString(),
        signer: otherAccount.signer,
      }),
    ).rejects.toThrow(/ERR:AUTH/)
  })

  test('deleteBoxes deletes app registry boxes', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)
    await client.send.register({ args: { appId: 1002 } })

    const address = getApplicationAddress(1002).toString()
    const { return: existsBefore } = await client.send.exists({ args: { address } })
    expect(existsBefore).toBe(true)

    // Get the 4-byte box key for this app
    const appBoxKey = getApplicationAddress(1002).publicKey.slice(0, 4)
    await client.send.deleteBoxes({
      args: { boxKeys: [appBoxKey] },
      boxReferences: [appBoxKey],
    })

    const { return: existsAfter } = await client.send.exists({ args: { address } })
    expect(existsAfter).toBe(false)
  })

  test('withdraw sends funds to admin', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await client.send.withdraw({
      args: { amount: 100_000 },
      extraFee: (1000).microAlgo(),
    })
  })

  test('withdraw fails for non-admin (ERR:AUTH)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const otherAccount = await localnet.algorand.account.random()
    await localnet.algorand.account.ensureFundedFromEnvironment(otherAccount.addr, (10).algos())

    await expect(
      client.send.withdraw({
        args: { amount: 100_000 },
        extraFee: (1000).microAlgo(),
        sender: otherAccount.addr.toString(),
        signer: otherAccount.signer,
      }),
    ).rejects.toThrow(/ERR:AUTH/)
  })

  test('deleteApplication fails for non-admin (ERR:AUTH)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const otherAccount = await localnet.algorand.account.random()
    await localnet.algorand.account.ensureFundedFromEnvironment(otherAccount.addr, (10).algos())

    await expect(
      client.send.delete.deleteApplication({
        args: {},
        sender: otherAccount.addr.toString(),
        signer: otherAccount.signer,
      }),
    ).rejects.toThrow(/ERR:AUTH/)
  })

  test('updateApplication fails for non-admin (ERR:AUTH)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const otherAccount = await localnet.algorand.account.random()
    await localnet.algorand.account.ensureFundedFromEnvironment(otherAccount.addr, (10).algos())

    await expect(
      client.send.update.updateApplication({
        args: {},
        sender: otherAccount.addr.toString(),
        signer: otherAccount.signer,
      }),
    ).rejects.toThrow(/ERR:AUTH/)
  })
})
