import { EscregSDK } from "escreg-sdk";
import { parseAppIdsFromFile, parseAppIdsFromArgs, parseAddressesFromFile, parseAddressesFromArgs } from "./parse";
import { createAlgorandClient, createWriterAccount, convertAppIdsToAddresses } from "./utils";
import { getConfig } from "./config";

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
    console.log({ writerAccount: writerAccount?.addr.toString() });

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
      writerAccount,
    });

    let appIds: bigint[];
    if (argv.file) {
      appIds = parseAppIdsFromFile(argv.file);
    } else {
      appIds = parseAppIdsFromArgs(argv.appIds);
    }

    console.log(`Registering ${appIds.length} application IDs with concurrency ${argv.concurrency}...`);
    const txIds = await sdk.register({ appIds, concurrency: argv.concurrency, debug: argv.debug, skipCheck: argv.skipCheck });

    if (txIds.length) {
      console.log("Registration successful!");
      console.log("Transaction IDs:");
      txIds.forEach((txId, index) => {
        console.log(`  ${index + 1}. ${txId}`);
      });
    }
  } catch (error) {
    console.error("Error registering app IDs:", (error as Error).message);
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
    console.debug(`Looking up ${addresses.length} addresses with concurrency ${argv.concurrency}...`);
    const result = await sdk.lookup({ addresses, concurrency: argv.concurrency, debug: argv.debug });

    let notfound = 0;
    console.debug("Lookup results:");
    for (const [address, appId] of Object.entries(result)) {
      if (appId !== undefined) {
        console.log(`${address} ${appId.toString()}`);
      } else {
        notfound++;
        console.log(`${address} N/A`);
      }
    }
    if (notfound > 0) {
      console.warn(`WARNING: ${notfound} addresses were not found in the registry`);
    }
  } catch (error) {
    console.error("Error looking up addresses:", (error as Error).message);
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

    process.stderr.write("Conversion results:\n");
    appIds.forEach((appId, index) => {
      process.stderr.write(`  ${appId.toString()}: `);
      process.stdout.write(`${addresses[index]}\n`);
    });
  } catch (error) {
    console.error("Error converting app IDs:", (error as Error).message);
    process.exit(1);
  }
}

// destroyApp requires full client, disabled while using minimal client for bundle size
// export async function handleDestroyCommand(argv: any) {
//   try {
//     const config = getConfig();
//     const algorand = createAlgorandClient({
//       algodHost: argv.algodHost,
//       algodPort: argv.algodPort,
//       algodToken: argv.algodToken,
//       appId: argv.appId,
//     });
//
//     const mnemonic = argv.mnemonic || config.mnemonic;
//     const address = argv.address || config.address;
//
//     const writerAccount = createWriterAccount(mnemonic, address);
//
//     if (!writerAccount) {
//       throw new Error("Writer account is required for destroy operation. Please provide a mnemonic.");
//     }
//
//     const sdk = new EscregSDK({
//       appId: BigInt(argv.appId),
//       algorand,
//       writerAccount,
//     });
//
//     console.log(`Destroying registry contract ${argv.appId}...`);
//     await sdk.destroyApp({ debug: argv.debug, concurrency: argv.concurrency });
//
//     console.log("Registry destroyed successfully!");
//   } catch (error) {
//     console.error("Error destroying registry:", (error as Error).message);
//     process.exit(1);
//   }
// }

export async function handleDepositCreditCommand(argv: any) {
  try {
    const config = getConfig();
    const algorand = createAlgorandClient({
      algodHost: argv.algodHost,
      algodPort: argv.algodPort,
      algodToken: argv.algodToken,
      appId: argv.appId,
    });

    const mnemonic = argv.mnemonic || config.mnemonic;
    const address = argv.address || config.address;

    const writerAccount = createWriterAccount(mnemonic, address);

    if (!writerAccount) {
      throw new Error("Writer account is required for deposit operation. Please provide a mnemonic.");
    }

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
      writerAccount,
    });

    const amount = BigInt(argv.amount);
    const creditor = argv.creditor || writerAccount.addr.toString();

    console.log(`Depositing ${amount.toString()} microAlgos as credits for ${creditor}...`);
    const txId = await sdk.depositCredit({ creditor, amount, debug: argv.debug });

    console.log("Deposit successful!");
    console.log(`Transaction ID: ${txId}`);
  } catch (error) {
    console.error("Error depositing credits:", (error as Error).message);
    process.exit(1);
  }
}

export async function handleWithdrawCreditCommand(argv: any) {
  try {
    const config = getConfig();
    const algorand = createAlgorandClient({
      algodHost: argv.algodHost,
      algodPort: argv.algodPort,
      algodToken: argv.algodToken,
      appId: argv.appId,
    });

    const mnemonic = argv.mnemonic || config.mnemonic;
    const address = argv.address || config.address;

    const writerAccount = createWriterAccount(mnemonic, address);

    if (!writerAccount) {
      throw new Error("Writer account is required for withdraw-credit operation. Please provide a mnemonic.");
    }

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
      writerAccount,
    });

    console.log("Withdrawing all credits...");
    const txId = await sdk.withdrawCredit({ debug: argv.debug });

    console.log("Credit withdrawal successful!");
    console.log(`Transaction ID: ${txId}`);
  } catch (error) {
    console.error("Error withdrawing credits:", (error as Error).message);
    process.exit(1);
  }
}

export async function handleWithdrawCommand(argv: any) {
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

    if (!writerAccount) {
      throw new Error("Writer account is required for withdraw operation. Please provide a mnemonic.");
    }

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
      writerAccount,
    });

    const amount = BigInt(argv.amount);

    console.log(`Withdrawing ${amount.toString()} microAlgos from contract ${argv.appId}...`);
    const txId = await sdk.withdraw({ amount, debug: argv.debug });

    console.log("Withdrawal successful!");
    console.log(`Transaction ID: ${txId}`);
  } catch (error) {
    console.error("Error withdrawing funds:", (error as Error).message);
    process.exit(1);
  }
}
