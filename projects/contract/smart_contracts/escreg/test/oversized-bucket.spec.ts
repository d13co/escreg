import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { TestBucketEscregClient, TestBucketEscregFactory } from '../../artifacts/escreg/TestBucketEscregClient'

/**
 * A bucket can grow to the 32768-byte box limit, but `box_get` cannot return a value over the
 * 4096-byte AVM limit, so readers have to probe it entry by entry. These tests build buckets either
 * side of that boundary and check the readers still resolve the app IDs in them.
 */
describe('Oversized buckets', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({ debug: true })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  /** Entries either side of the 4096-byte value limit: 4096 bytes exactly, then 8 bytes past it */
  const ENTRIES_AT_LIMIT = 512
  const ENTRIES_OVER_LIMIT = 513
  /** Chunk size for building a bucket, under the 2048-byte cap on total application arguments */
  const CHUNK_ENTRIES = 200
  /**
   * Opcode budget to pool per entry scanned. Measured at ~73, dominated by the sha512_256 that
   * derives each candidate's escrow address; the rest is margin.
   */
  const OPCODES_PER_ENTRY = 85

  const deploy = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(TestBucketEscregFactory, {
      defaultSender: account,
    })

    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

    // covers the MBR of a bucket past the value limit: 2500 + 400 * (4 + 4104)
    await localnet.algorand.send.payment({
      sender: account,
      receiver: appClient.appAddress,
      amount: (3).algos(),
    })

    return { client: appClient }
  }

  const boxKeyOf = (appId: bigint) => getApplicationAddress(appId).publicKey.slice(0, 4)
  const addrOf = (appId: bigint) => getApplicationAddress(appId).toString()

  /** Pack app IDs the way the contract stores them: big-endian 8-byte IDs, back to back */
  const pack = (appIds: bigint[]) => {
    const packed = new Uint8Array(appIds.length * 8)
    const view = new DataView(packed.buffer)
    appIds.forEach((appId, i) => view.setBigUint64(i * 8, appId))
    return packed
  }

  /**
   * Box references for accessing a bucket of the given size. The read budget is 1024 bytes per
   * reference, so anything over 1024 needs padding references alongside the bucket itself.
   */
  const bucketRefs = (key: Uint8Array, size: number) => {
    const refs: Uint8Array[] = [key]
    while (refs.length < Math.ceil(size / 1024)) refs.push(new Uint8Array([refs.length]))
    return refs
  }

  const getBox = async (client: TestBucketEscregClient, key: Uint8Array) => {
    const { value } = await localnet.algorand.client.algod.getApplicationBoxByName(Number(client.appId), key).do()
    return value
  }

  /** The app ID every bucket here is keyed by. Filler entries are IDs that resolve to nothing else. */
  const TARGET = 1002n

  /**
   * Build a bucket of `count` entries under `TARGET`'s box key, planting the first chunk and
   * growing it a chunk at a time - a bucket past the value limit is also past the 2048-byte cap on
   * application arguments.
   *
   * @param holdsTarget Whether `TARGET` sits in the final slot, so a lookup for it has to scan
   *   every preceding entry. When false the bucket is all filler and the lookup finds no match.
   */
  const buildBucket = async (client: TestBucketEscregClient, count: number, { holdsTarget = true } = {}) => {
    const key = boxKeyOf(TARGET)
    const appIds = [...Array(count).keys()].map((i) => BigInt(i + 1))
    if (holdsTarget) appIds[count - 1] = TARGET

    const chunks: bigint[][] = []
    for (let i = 0; i < appIds.length; i += CHUNK_ENTRIES) chunks.push(appIds.slice(i, i + CHUNK_ENTRIES))

    const [first, ...rest] = chunks
    await client.send.plantBucket({
      args: { key, value: pack(first), entries: first.length },
      boxReferences: [key],
    })
    let size = first.length * 8
    for (const chunk of rest) {
      size += chunk.length * 8
      await client.send.growBucket({
        args: { key, value: pack(chunk), entries: chunk.length },
        boxReferences: bucketRefs(key, size),
      })
    }

    return { key, size }
  }

  /** Start a group with enough pooled opcode budget to scan `entries` entries. */
  const withBudget = (client: TestBucketEscregClient, entries: number) => {
    const itxns = Math.ceil((entries * OPCODES_PER_ENTRY) / 700) + 1
    return client.newGroup().increaseBudget({ args: { itxns }, extraFee: (itxns * 1000).microAlgo() })
  }

  test('a bucket can grow past the 4096-byte value limit', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const { key, size } = await buildBucket(client, ENTRIES_OVER_LIMIT)

    expect(size).toBe(4104)
    expect((await getBox(client, key)).length).toBe(4104)
  })

  test('readers resolve an app ID in a bucket at the 4096-byte value limit', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const { key, size } = await buildBucket(client, ENTRIES_AT_LIMIT)
    expect(size).toBe(4096)

    const { returns } = await withBudget(client, ENTRIES_AT_LIMIT)
      .get({ args: { address: addrOf(TARGET) }, boxReferences: bucketRefs(key, size) })
      .send()

    expect(returns.at(-1)).toBe(TARGET)
  })

  test('readers resolve an app ID in a bucket past the 4096-byte value limit', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const { key, size } = await buildBucket(client, ENTRIES_OVER_LIMIT)
    const refs = bucketRefs(key, size)
    const address = addrOf(TARGET)

    // one group each: a scan this size all but exhausts a group's pooled budget on its own
    const budget = () => withBudget(client, ENTRIES_OVER_LIMIT)
    const results = [
      (await budget().get({ args: { address }, boxReferences: refs }).send()).returns.at(-1),
      (await budget().exists({ args: { address }, boxReferences: refs }).send()).returns.at(-1),
      (await budget().mustGet({ args: { address }, boxReferences: refs }).send()).returns.at(-1),
      (
        await budget()
          .getList({ args: { addresses: [address] }, boxReferences: refs })
          .send()
      ).returns.at(-1),
    ]

    expect(results).toEqual([TARGET, true, TARGET, [TARGET]])
  })

  test('a lookup misses cleanly in an oversized bucket that holds no match', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const { key, size } = await buildBucket(client, ENTRIES_OVER_LIMIT, { holdsTarget: false })

    const { returns } = await withBudget(client, ENTRIES_OVER_LIMIT)
      .get({ args: { address: addrOf(TARGET) }, boxReferences: bucketRefs(key, size) })
      .send()

    expect(returns.at(-1)).toBe(0n)
  })
})
