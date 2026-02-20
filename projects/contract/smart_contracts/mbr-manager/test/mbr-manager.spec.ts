import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Address, getApplicationAddress } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { MbrManagerClient, MbrManagerFactory } from '../../artifacts/mbr-manager/MbrManagerClient'

describe('MbrManager contract', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
    })
    registerDebugEventHandlers()
  })
  beforeEach(localnet.newScope)

  const deploy = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(MbrManagerFactory, {
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

  const depositCredits = async (client: MbrManagerClient, account: Address, amount: bigint) => {
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

  test('depositCredits creates user credit box', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 500_000n)

    const boxMap = await client.state.box.userCredits.getMap()
    expect(boxMap.has(testAccount.addr.toString())).toBe(true)
  })

  test('depositCredits deducts box MBR on first deposit', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const depositAmount = 500_000n
    await depositCredits(client, testAccount, depositAmount)

    // Box MBR = 2500 + 400 * (33 key + 8 value) = 18900
    const boxMap = await client.state.box.userCredits.getMap()
    const credited = boxMap.get(testAccount.addr.toString())
    expect(credited).toBe(depositAmount - 18_900n)
  })

  test('depositCredits accumulates on second deposit', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 300_000n)
    await depositCredits(client, testAccount, 200_000n)

    // Only first deposit deducts MBR
    const boxMap = await client.state.box.userCredits.getMap()
    const credited = boxMap.get(testAccount.addr.toString())
    expect(credited).toBe(300_000n - 18_900n + 200_000n)
  })

  test('withdrawCredits returns credits and deletes box', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    await depositCredits(client, testAccount, 500_000n)

    const boxRef = Address.fromString(testAccount.addr.toString()).publicKey
    await client.send.withdrawCredits({
      args: {},
      boxReferences: [boxRef],
      extraFee: (1000).microAlgo(),
    })

    const boxMap = await client.state.box.userCredits.getMap()
    expect(boxMap.has(testAccount.addr.toString())).toBe(false)
  })

  test('withdrawCredits fails without prior deposit', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const boxRef = Address.fromString(testAccount.addr.toString()).publicKey
    await expect(
      client.send.withdrawCredits({
        args: {},
        boxReferences: [boxRef],
        extraFee: (1000).microAlgo(),
      }),
    ).rejects.toThrow(/ERR:AMT/)
  })

  test('depositCredits fails with wrong receiver (ERR:RCV)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    // Pay to the sender instead of the contract
    const payTxn = await localnet.algorand.createTransaction.payment({
      sender: testAccount,
      receiver: testAccount,
      amount: (100_000).microAlgo(),
    })
    const boxRef = Address.fromString(testAccount.addr.toString()).publicKey

    await expect(
      client.send.depositCredits({
        args: { creditor: testAccount.addr.toString(), txn: payTxn },
        boxReferences: [boxRef],
      }),
    ).rejects.toThrow(/ERR:RCV/)
  })

  test('depositCredits fails with zero amount (ERR:AMT)', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    const payTxn = await localnet.algorand.createTransaction.payment({
      sender: testAccount,
      receiver: client.appAddress,
      amount: (0).microAlgo(),
    })
    const boxRef = Address.fromString(testAccount.addr.toString()).publicKey

    await expect(
      client.send.depositCredits({
        args: { creditor: testAccount.addr.toString(), txn: payTxn },
        boxReferences: [boxRef],
      }),
    ).rejects.toThrow(/ERR:AMT/)
  })

  test('depositCredits can credit a different account', async () => {
    const { testAccount } = localnet.context
    const { client } = await deploy(testAccount)

    // First deposit for the sender to cover the other account's box MBR
    await depositCredits(client, testAccount, 100_000n)

    const otherAccount = await localnet.algorand.account.random()

    const payTxn = await localnet.algorand.createTransaction.payment({
      sender: testAccount,
      receiver: client.appAddress,
      amount: (100_000).microAlgo(),
    })
    const senderBoxRef = Address.fromString(testAccount.addr.toString()).publicKey
    const otherBoxRef = Address.fromString(otherAccount.addr.toString()).publicKey

    await client.send.depositCredits({
      args: { creditor: otherAccount.addr.toString(), txn: payTxn },
      boxReferences: [senderBoxRef, otherBoxRef],
    })

    const boxMap = await client.state.box.userCredits.getMap()
    expect(boxMap.has(otherAccount.addr.toString())).toBe(true)
  })

})
