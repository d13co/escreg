import { Config } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { Account, Address } from 'algosdk'
import { EscregSDK } from 'escreg-sdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { EscregFactory } from '../../artifacts/escreg/EscregClient'

describe('MBR Credits', () => {
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

  test('depositCredit deducts box MBR on first deposit', async () => {
    const { testAccount } = localnet.context
    const { sdk, client } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()
    const depositAmount = 500_000n

    const txId = await sdk.depositCredit({ creditor, amount: depositAmount })
    expect(txId).toBeTruthy()

    // First deposit creates the userCredits box, so MBR is deducted from the credited amount
    // Box MBR = 2500 + 400 * (33 key + 8 value) = 18900
    const boxMap = await client.state.box.userCredits.getMap()
    const credited = boxMap.get(creditor)
    expect(credited).toBe(depositAmount - 18_900n)
  })

  test('depositCredit accumulates without MBR deduction on second deposit', async () => {
    const { testAccount } = localnet.context
    const { sdk, client } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()

    await sdk.depositCredit({ creditor, amount: 300_000n })
    await sdk.depositCredit({ creditor, amount: 200_000n })

    // Only first deposit deducts MBR
    const boxMap = await client.state.box.userCredits.getMap()
    const credited = boxMap.get(creditor)
    expect(credited).toBe(300_000n - 18_900n + 200_000n)
  })

  test('withdrawCredit withdraws everything and deletes box', async () => {
    const { testAccount } = localnet.context
    const { sdk, client } = await deploy(testAccount)

    const creditor = testAccount.addr.toString()

    await sdk.depositCredit({ creditor, amount: 500_000n })

    const txId = await sdk.withdrawCredit()
    expect(txId).toBeTruthy()

    // Box should be deleted after withdrawCredits
    const boxMap = await client.state.box.userCredits.getMap()
    expect(boxMap.has(creditor)).toBe(false)
  })

  test('withdrawCredit fails without prior deposit', async () => {
    const { testAccount } = localnet.context
    const { sdk } = await deploy(testAccount)

    await expect(sdk.withdrawCredit()).rejects.toThrow(/AMT/)
  })
})
