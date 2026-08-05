import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { EscregSDK } from '@d13co/escreg-sdk'
import { ABIArrayDynamicType, ABIUintType, Account, Address, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { TestLegacyEscregClient, TestLegacyEscregFactory } from '../../artifacts/escreg/TestLegacyEscregClient'
import { getCollidingAppIDs } from './fixtures'

/** The pre-migration bucket layout: an ARC-4 uint64[], i.e. a 2-byte count then 8 bytes per app ID */
const legacyBucketType = new ABIArrayDynamicType(new ABIUintType(64))

describe('Legacy bucket migration', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({ debug: true })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  const deploy = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(TestLegacyEscregFactory, {
      defaultSender: account,
    })

    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

    await localnet.algorand.send.payment({
      sender: account,
      receiver: appClient.appAddress,
      amount: (1).algos(),
    })

    return { client: appClient }
  }

  const boxKeyOf = (appId: number | bigint) => getApplicationAddress(appId).publicKey.slice(0, 4)

  /** Plant a bucket for the given app IDs in the pre-migration layout. They must share a prefix. */
  const plantLegacyBucket = async (client: TestLegacyEscregClient, appIds: bigint[]) => {
    const key = boxKeyOf(appIds[0])
    await client.send.plantBucket({
      args: { key, value: legacyBucketType.encode(appIds), entries: appIds.length },
      boxReferences: [key],
    })
    return key
  }

  const getBox = async (client: TestLegacyEscregClient, key: Uint8Array) => {
    const { value } = await localnet.algorand.client.algod.getApplicationBoxByName(Number(client.appId), key).do()
    return value
  }

  /** Decode a packed bucket: big-endian 8-byte app IDs, no length header */
  const decodePacked = (value: Uint8Array): bigint[] => {
    expect(value.length % 8).toBe(0)
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
    return new Array(value.length / 8).fill(0).map((_, i) => view.getBigUint64(i * 8))
  }

  const addrOf = (appId: bigint) => getApplicationAddress(appId).toString()

  test('legacy bucket is 2 bytes longer than a packed one', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const key = await plantLegacyBucket(client, [1002n])

    // 2-byte ARC-4 length header + one 8-byte app ID
    expect((await getBox(client, key)).length).toBe(10)
  })

  test('readers resolve app IDs from a legacy bucket', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await plantLegacyBucket(client, [1002n])

    expect((await client.send.get({ args: { address: addrOf(1002n) } })).return).toBe(1002n)
    expect((await client.send.exists({ args: { address: addrOf(1002n) } })).return).toBe(true)
    expect((await client.send.mustGet({ args: { address: addrOf(1002n) } })).return).toBe(1002n)
    expect((await client.send.getList({ args: { addresses: [addrOf(1002n)] } })).return).toEqual([1002n])

    // getWithAuth reads the account's auth address, so it needs an escrow that exists on chain:
    // plant a bucket for the test app itself, which deploy() funds
    await plantLegacyBucket(client, [client.appId])
    expect((await client.send.getWithAuth({ args: { address: client.appAddress.toString() } })).return).toEqual({
      appId: client.appId,
      authAppId: 0n,
    })
  })

  test('readers resolve every app ID in a multi-entry legacy bucket', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const [first, second] = getCollidingAppIDs(2)
    await plantLegacyBucket(client, [first, second])

    const { return: results } = await client.send.getList({ args: { addresses: [addrOf(first), addrOf(second)] } })
    expect(results).toEqual([first, second])
  })

  test('readers handle legacy and packed buckets side by side', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await localnet.algorand.send.payment({
      sender: testAccount,
      receiver: client.appAddress,
      amount: (100_000).microAlgo(),
    })
    await client.send.depositCredits({
      args: {
        creditor: testAccount.toString(),
        txn: await localnet.algorand.createTransaction.payment({
          sender: testAccount,
          receiver: client.appAddress,
          amount: (100_000).microAlgo(),
        }),
      },
      boxReferences: [Address.fromString(testAccount.toString()).publicKey],
    })

    await plantLegacyBucket(client, [1002n])
    await client.send.register({ args: { appId: 1003 } })

    expect((await getBox(client, boxKeyOf(1002n))).length).toBe(10)
    expect((await getBox(client, boxKeyOf(1003n))).length).toBe(8)

    const { return: results } = await client.send.getList({
      args: { addresses: [addrOf(1002n), addrOf(1003n)] },
    })
    expect(results).toEqual([1002n, 1003n])
  })

  test('migrateBoxes strips the header and preserves the app IDs', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const [first, second] = getCollidingAppIDs(2)
    const key = await plantLegacyBucket(client, [first, second])
    expect((await getBox(client, key)).length).toBe(18)

    const { return: migrated } = await client.send.migrateBoxes({ args: { boxKeys: [key] }, boxReferences: [key] })
    expect(migrated).toBe(1n)

    const value = await getBox(client, key)
    expect(value.length).toBe(16)
    expect(decodePacked(value)).toEqual([first, second])

    const { return: results } = await client.send.getList({ args: { addresses: [addrOf(first), addrOf(second)] } })
    expect(results).toEqual([first, second])
  })

  test('migrateBoxes frees 800 microAlgos of MBR per box', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const key = await plantLegacyBucket(client, [1002n])

    const before = (await localnet.algorand.client.algod.accountInformation(client.appAddress).do()).minBalance
    await client.send.migrateBoxes({ args: { boxKeys: [key] }, boxReferences: [key] })
    const after = (await localnet.algorand.client.algod.accountInformation(client.appAddress).do()).minBalance

    expect(before - after).toBe(800n)
  })

  test('migrateBoxes is idempotent and skips missing keys', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const key = await plantLegacyBucket(client, [1002n])
    const missing = boxKeyOf(999_999n)

    expect((await client.send.migrateBoxes({ args: { boxKeys: [key] }, boxReferences: [key] })).return).toBe(1n)
    expect((await client.send.migrateBoxes({ args: { boxKeys: [key] }, boxReferences: [key] })).return).toBe(0n)
    expect(
      (await client.send.migrateBoxes({ args: { boxKeys: [key, missing] }, boxReferences: [key, missing] })).return,
    ).toBe(0n)

    expect(decodePacked(await getBox(client, key))).toEqual([1002n])
  })

  test('migrateBoxes converts a batch of mixed buckets', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const colliding = getCollidingAppIDs(6)
    const pairs = [colliding.slice(0, 2), colliding.slice(2, 4), colliding.slice(4, 6)]

    const legacyKeys = [await plantLegacyBucket(client, pairs[0]), await plantLegacyBucket(client, pairs[1])]
    const packedKey = boxKeyOf(pairs[2][0])
    await client.send.plantBucket({
      args: {
        key: packedKey,
        value: new Uint8Array(pairs[2].flatMap((id) => [...legacyBucketType.encode([id]).slice(2)])),
        entries: 2,
      },
      boxReferences: [packedKey],
    })

    const keys = [...legacyKeys, packedKey]
    const { return: migrated } = await client.send.migrateBoxes({ args: { boxKeys: keys }, boxReferences: keys })
    expect(migrated).toBe(2n)

    for (const pair of pairs) {
      expect(decodePacked(await getBox(client, boxKeyOf(pair[0])))).toEqual(pair)
    }

    const addresses = colliding.map(addrOf)
    expect((await client.send.getList({ args: { addresses } })).return).toEqual(colliding)
  })

  test('migrateBoxes fails for non-admin (ERR:AUTH)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const key = await plantLegacyBucket(client, [1002n])

    const otherAccount = await localnet.algorand.account.random()
    await localnet.algorand.account.ensureFundedFromEnvironment(otherAccount.addr, (10).algos())

    await expect(
      client.send.migrateBoxes({
        args: { boxKeys: [key] },
        boxReferences: [key],
        sender: otherAccount.addr.toString(),
        signer: otherAccount.signer,
      }),
    ).rejects.toThrow(/ERR:AUTH/)
  })

  test('registering into a legacy bucket converts it to packed', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await client.send.depositCredits({
      args: {
        creditor: testAccount.toString(),
        txn: await localnet.algorand.createTransaction.payment({
          sender: testAccount,
          receiver: client.appAddress,
          amount: (100_000).microAlgo(),
        }),
      },
      boxReferences: [Address.fromString(testAccount.toString()).publicKey],
    })

    const [first, second] = getCollidingAppIDs(2)
    const key = await plantLegacyBucket(client, [first])
    expect((await getBox(client, key)).length).toBe(10)

    await client.send.register({ args: { appId: second }, boxReferences: [key] })

    const value = await getBox(client, key)
    expect(value.length).toBe(16)
    expect(decodePacked(value)).toEqual([first, second])
    expect(await client.state.global.counter()).toBe(2n)
  })

  test('re-registering an app ID already in a legacy bucket is a no-op', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await client.send.depositCredits({
      args: {
        creditor: testAccount.toString(),
        txn: await localnet.algorand.createTransaction.payment({
          sender: testAccount,
          receiver: client.appAddress,
          amount: (100_000).microAlgo(),
        }),
      },
      boxReferences: [Address.fromString(testAccount.toString()).publicKey],
    })

    const key = await plantLegacyBucket(client, [1002n])
    await client.send.register({ args: { appId: 1002 }, boxReferences: [key] })

    // left untouched, header and all
    expect((await getBox(client, key)).length).toBe(10)
    expect(await client.state.global.counter()).toBe(1n)
  })

  test('deleteBoxes counts entries in a legacy bucket correctly', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const [first, second] = getCollidingAppIDs(2)
    const key = await plantLegacyBucket(client, [first, second])
    expect(await client.state.global.counter()).toBe(2n)

    await client.send.deleteBoxes({ args: { boxKeys: [key] }, boxReferences: [key] })

    expect(await client.state.global.counter()).toBe(0n)
  })

  describe('via the SDK', () => {
    const hex = (key: Uint8Array) => Buffer.from(key).toString('hex')
    const sortedHex = (keys: Uint8Array[]) => keys.map(hex).sort()

    /** Plant three legacy buckets and register two packed ones, returning the legacy keys */
    const seedMixedRegistry = async (
      client: TestLegacyEscregClient,
      sdk: EscregSDK,
      account: Address & TransactionSignerAccount & Account,
    ) => {
      await sdk.depositCredit({ creditor: account.addr.toString(), amount: 200_000n })

      const colliding = getCollidingAppIDs(6)
      const legacyKeys: Uint8Array[] = []
      for (const pair of [colliding.slice(0, 2), colliding.slice(2, 4), colliding.slice(4, 6)]) {
        legacyKeys.push(await plantLegacyBucket(client, pair))
      }

      await sdk.register({ appIds: [1002n, 1003n] })

      return { legacyKeys, colliding }
    }

    const deployWithSdk = async (account: Address & TransactionSignerAccount & Account) => {
      const { client } = await deploy(account)
      const sdk = new EscregSDK({ algorand: localnet.algorand, appId: client.appId, writerAccount: account })
      return { client, sdk }
    }

    test('findLegacyBoxes reports only legacy buckets', async () => {
      const { testAccount } = localnet.context
      const { client, sdk } = await deployWithSdk(testAccount)

      const { legacyKeys } = await seedMixedRegistry(client, sdk, testAccount)

      // pageSize 2 over 5 registry boxes plus a credit box, so the listing cursor is exercised on a
      // node that pages; an older one answers with the whole listing and has its values fetched per box
      const found = await sdk.findLegacyBoxes({ pageSize: 2 })

      expect(sortedHex(found)).toEqual(sortedHex(legacyKeys))
    })

    test('migrateBoxes converts every box findLegacyBoxes reports', async () => {
      const { testAccount } = localnet.context
      const { client, sdk } = await deployWithSdk(testAccount)

      const { legacyKeys, colliding } = await seedMixedRegistry(client, sdk, testAccount)

      const txIds = await sdk.migrateBoxes({ boxKeys: await sdk.findLegacyBoxes() })
      expect(txIds.length).toBeGreaterThan(0)

      expect(await sdk.findLegacyBoxes()).toEqual([])
      for (const key of legacyKeys) {
        expect((await getBox(client, key)).length % 8).toBe(0)
      }

      // every registration is still resolvable, migrated or not
      const addresses = [...colliding, 1002n, 1003n].map(addrOf)
      const expected = Object.fromEntries([...colliding, 1002n, 1003n].map((id) => [addrOf(id), id]))
      expect(await sdk.lookup({ addresses })).toEqual(expected)
    })

    test('migrateBoxes on an already packed registry is a no-op', async () => {
      const { testAccount } = localnet.context
      const { client, sdk } = await deployWithSdk(testAccount)

      await sdk.depositCredit({ creditor: testAccount.addr.toString(), amount: 100_000n })
      await sdk.register({ appIds: [1002n] })

      expect(await sdk.findLegacyBoxes()).toEqual([])
      expect(await sdk.migrateBoxes({ boxKeys: [] })).toEqual([])
      expect(decodePacked(await getBox(client, boxKeyOf(1002n)))).toEqual([1002n])
    })
  })
})
