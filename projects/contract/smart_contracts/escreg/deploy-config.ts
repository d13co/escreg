import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Address } from 'algosdk'
import { EscregFactory } from '../artifacts/escreg/EscregClient'

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log('=== Deploying Escreg ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(EscregFactory, {
    defaultSender: deployer.addr,
  })

  try {
    const { appClient, result } = await factory.deploy({
      onUpdate: 'update',
      onSchemaBreak: 'append',
      updateParams: {
        method: 'updateApplication()void',
        args: {},
      },
      deleteParams: {
        method: 'deleteApplication()void',
        args: {},
      },
      existingDeployments: {
        creator: Address.fromString('REGISTRY2UJANM5G2G45MZD4DKPH7RPBDJRJ3HSFDPO4IY7HKU5ZY4MLV4'),
        apps: {
          // @ts-ignore
          Escreg: {
            appId: 16382607n,
          },
        },
      },
    })

    // If app was just created fund the app account
    if (['create', 'replace'].includes(result.operationPerformed)) {
      await algorand.send.payment({
        amount: (5).algo(),
        sender: deployer.addr,
        receiver: appClient.appAddress,
      })
    }

    const dispenser = await algorand.account.dispenserFromEnvironment()
    await algorand.account.ensureFunded(appClient.appAddress, dispenser, (1000).algos())
    const { balance, minBalance } = await algorand.account.getInformation(appClient.appAddress)
    console.log('Balance: ', balance.algos, 'spendable:', balance.algo - minBalance.algo)
  } catch (e) {
    console.error(e)
  }
}
