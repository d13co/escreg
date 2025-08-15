import { EscregSDK } from 'escreg-sdk';
import { parseAppIdsFromFile, parseAppIdsFromArgs, parseAddressesFromFile, parseAddressesFromArgs } from './parse';
import { createAlgorandClient, createWriterAccount, convertAppIdsToAddresses } from './utils';
import { getConfig } from './config';

export async function handleRegisterCommand(argv: any) {
  try {
    const config = getConfig();
    const algorand = createAlgorandClient({
      algodHost: argv.algodHost,
      algodPort: argv.algodPort,
      algodToken: argv.algodToken,
      appId: argv.appId,
    });

    // Use CLI mnemonic if provided, otherwise fall back to config/env
    const mnemonic = argv.mnemonic || config.mnemonic;
    const address = argv.address || config.address;
    
    const writerAccount = createWriterAccount(mnemonic, address);
    console.log({ writerAccount: writerAccount?.addr.toString() })

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
      writerAccount,
    })

    let appIds: bigint[];
    if (argv.file) {
      appIds = parseAppIdsFromFile(argv.file);
    } else {
      appIds = parseAppIdsFromArgs(argv.appIds);
    }

    console.log(`Registering ${appIds.length} application IDs with concurrency ${argv.concurrency}...`);
    const txIds = await sdk.register({ appIds, concurrency: argv.concurrency, debug: argv.debug, skipCheck: argv.skipCheck });

    console.log('Registration successful!');
    console.log('Transaction IDs:');
    txIds.forEach((txId, index) => {
      console.log(`  ${index + 1}. ${txId}`);
    });
  } catch (error) {
    console.error('Error registering app IDs:', error);
    process.exit(1);
  }
}

export async function handleLookupCommand(argv: any) {
  try {
    const config = getConfig();
    const algorand = createAlgorandClient({
      algodHost: argv.algodHost,
      algodPort: argv.algodPort,
      algodToken: argv.algodToken,
      appId: argv.appId,
    });

    // Use CLI mnemonic if provided, otherwise fall back to config/env
    const mnemonic = argv.mnemonic || config.mnemonic;
    const address = argv.address || config.address;
    
    const writerAccount = createWriterAccount(mnemonic, address);

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
      writerAccount,
    });

    let addresses: string[];
    if (argv.file) {
      addresses = parseAddressesFromFile(argv.file);
    } else {
      addresses = parseAddressesFromArgs(argv.addresses);
    }
    console.log({ addresses })
    console.log(`Looking up ${addresses.length} addresses with concurrency ${argv.concurrency}...`);
    const result = await sdk.lookup({ addresses, concurrency: argv.concurrency, debug: argv.debug });

    console.log('Lookup results:');
    for (const [address, appId] of Object.entries(result)) {
      if (appId !== undefined) {
        console.log(`  ${address}: ${appId.toString()}`);
      } else {
        console.log(`  ${address}: Not found`);
      }
    }
  } catch (error) {
    console.error('Error looking up addresses:', error);
    process.exit(1);
  }
}

export async function handleConvertCommand(argv: any) {
  try {
    let appIds: bigint[];
    if (argv.file) {
      appIds = parseAppIdsFromFile(argv.file);
    } else {
      appIds = parseAppIdsFromArgs(argv.appIds);
    }

    process.stderr.write(`Converting ${appIds.length} application IDs to addresses...\n`);
    const addresses = convertAppIdsToAddresses(appIds);

    process.stderr.write('Conversion results:\n');
    appIds.forEach((appId, index) => {
      process.stderr.write(`  ${appId.toString()}: `);
      process.stdout.write(`${addresses[index]}\n`);
    });
  } catch (error) {
    console.error('Error converting app IDs:', error);
    process.exit(1);
  }
}
