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

  /** Read the raw registry box holding the given app ID's bucket */
  const getAppBox = async (client: EscregClient, appId: number | bigint) => {
    const boxKey = getApplicationAddress(appId).publicKey.slice(0, 4)
    const { value } = await localnet.algorand.client.algod.getApplicationBoxByName(Number(client.appId), boxKey).do()
    return value
  }

  /** Decode a bucket: big-endian 8-byte app IDs packed back to back, no length header */
  const decodeBucket = (value: Uint8Array): bigint[] => {
    expect(value.length % 8).toBe(0)
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
    return new Array(value.length / 8).fill(0).map((_, i) => view.getBigUint64(i * 8))
  }

  const getCredit = async (client: EscregClient, account: Address) =>
    (await client.state.box.userCredits.getMap()).get(account.toString())!

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

  test('bucket holds a packed 8-byte app ID with no length header', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)
    await client.send.register({ args: { appId: 1002 } })

    const value = await getAppBox(client, 1002)
    expect(value.length).toBe(8)
    expect(decodeBucket(value)).toEqual([1002n])
  })

  test('colliding app IDs are packed back to back in one bucket', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)

    const [first, second] = getCollidingAppIDs(2)
    await client.send.registerList({ args: { appIds: [first, second] } })

    const value = await getAppBox(client, first)
    expect(value.length).toBe(16)
    expect(decodeBucket(value)).toEqual([first, second])

    const addresses = [first, second].map((appId) => getApplicationAddress(appId).toString())
    const { return: results } = await client.send.getList({ args: { addresses } })
    expect(results).toEqual([first, second])

    expect(await client.state.global.counter()).toBe(2n)
  })

  test('re-registering a colliding app ID does not grow its bucket', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)

    const [first, second] = getCollidingAppIDs(2)
    await client.send.registerList({ args: { appIds: [first, second] } })
    await client.send.register({ args: { appId: second } })

    expect(decodeBucket(await getAppBox(client, first))).toEqual([first, second])
    expect(await client.state.global.counter()).toBe(2n)
  })

  test('a new bucket costs 7300 microAlgos of MBR', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)

    const before = await getCredit(client, testAccount)
    await client.send.register({ args: { appId: 1002 } })
    const after = await getCredit(client, testAccount)

    // 2500 + 400 * (4 byte key + 8 byte value)
    expect(before - after).toBe(7_300n)
  })

  test('appending to a bucket costs 3200 microAlgos of MBR', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)

    const [first, second] = getCollidingAppIDs(2)
    await client.send.register({ args: { appId: first } })

    const before = await getCredit(client, testAccount)
    await client.send.register({ args: { appId: second } })
    const after = await getCredit(client, testAccount)

    // 400 * 8 bytes for the extra app ID, no header to grow
    expect(before - after).toBe(3_200n)
  })

  test('deleteBoxes decrements the counter by the whole bucket', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 100_000n)

    const [first, second] = getCollidingAppIDs(2)
    await client.send.registerList({ args: { appIds: [first, second] } })
    expect(await client.state.global.counter()).toBe(2n)

    const boxKey = getApplicationAddress(first).publicKey.slice(0, 4)
    await client.send.deleteBoxes({ args: { boxKeys: [boxKey] }, boxReferences: [boxKey] })

    expect(await client.state.global.counter()).toBe(0n)
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
