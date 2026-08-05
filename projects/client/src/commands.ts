import { once } from "events";
import { boxCursor, EscregSDK } from "@d13co/escreg-sdk";
import { parseAppIdsFromFile, parseAppIdsFromArgs, parseAddressesFromFile, parseAddressesFromArgs } from "./parse";
import { createAlgorandClient, createWriterAccount, convertAppIdsToAddresses } from "./utils";
import { clearCheckpoint, readCheckpoint, writeCheckpoint } from "./checkpoint";
import { bucketHeader, formatBucketRow } from "./format";
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

export async function handleCreditsCommand(argv: any) {
  try {
    const config = getConfig();
    const algorand = createAlgorandClient({
      algodHost: argv.algodHost,
      algodPort: argv.algodPort,
      algodToken: argv.algodToken,
      appId: argv.appId,
    });

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
    });

    let addresses: string[] | undefined;
    if (argv.file) {
      addresses = parseAddressesFromFile(argv.file);
    } else if (argv.addresses) {
      addresses = parseAddressesFromArgs(argv.addresses);
    }

    const result = await sdk.getCredits({
      addresses,
      all: argv.all,
      debug: argv.debug,
    });

    const entries = Object.entries(result);
    if (entries.length === 0) {
      console.log("No credit boxes found.");
      return;
    }

    for (const [address, credits] of entries) {
      const algo = Number(credits) / 1e6;
      console.log(`${address} ${algo} ALGO`);
    }

    if (addresses && !argv.all) {
      const missing = addresses.filter((a) => !(a in result));
      if (missing.length > 0) {
        console.warn(`WARNING: ${missing.length} addresses have no credit box`);
      }
    }
  } catch (error) {
    console.error("Error checking credits:", (error as Error).message);
    process.exit(1);
  }
}

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

    const amount = BigInt(parseFloat(argv.amount) * 1e6);
    const creditor = argv.creditor || writerAccount.addr.toString();

    console.log(`Depositing ${argv.amount} Algos as credits for ${creditor}...`);
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
      throw new Error("Writer account is required for withdraw-credits operation. Please provide a mnemonic.");
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

export async function handleMigrateCommand(argv: any) {
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

    if (!argv.dryRun && !writerAccount) {
      throw new Error("Writer account is required for migrate operation. Please provide a mnemonic.");
    }

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
      writerAccount,
    });

    const scanOptions = { concurrency: argv.concurrency, pageSize: argv.pageSize, debug: argv.debug };

    let totalMigrated = 0;
    const txIds: string[] = [];

    // A box written behind the listing cursor mid-scan is missed, so re-scan until a pass comes back clean
    for (let pass = 1; pass <= argv.maxPasses; pass++) {
      console.log(`Pass ${pass}/${argv.maxPasses}: scanning registry boxes for the legacy layout...`);
      const boxKeys = await sdk.findLegacyBoxes(scanOptions);

      if (!boxKeys.length) {
        console.log(totalMigrated ? "No legacy boxes left." : "No legacy boxes found, nothing to migrate.");
        break;
      }

      console.log(`Found ${boxKeys.length} legacy boxes (${boxKeys.length * 800} microAlgos of MBR to free).`);

      if (argv.dryRun) {
        console.log("Dry run, not migrating.");
        return;
      }

      txIds.push(...(await sdk.migrateBoxes({ boxKeys, concurrency: argv.concurrency, debug: argv.debug })));
      totalMigrated += boxKeys.length;
      console.log(`Migrated ${boxKeys.length} boxes (${totalMigrated} total).`);

      if (pass === argv.maxPasses) {
        console.warn(`Reached the pass limit with boxes still being found. Re-run to continue.`);
      }
    }

    if (totalMigrated) {
      console.log(`Migration complete: ${totalMigrated} boxes, ${totalMigrated * 800} microAlgos of MBR freed.`);
      console.log(`The freed MBR sits in the contract balance; recover it with 'withdraw'.`);
      if (argv.debug) {
        console.log("Transaction IDs:");
        txIds.forEach((txId, index) => console.log(`  ${index + 1}. ${txId}`));
      }
    }
  } catch (error) {
    console.error("Error migrating boxes:", (error as Error).message);
    process.exit(1);
  }
}

export async function handleDumpCommand(argv: any) {
  try {
    const algorand = createAlgorandClient({
      algodHost: argv.algodHost,
      algodPort: argv.algodPort,
      algodToken: argv.algodToken,
      appId: argv.appId,
    });

    const sdk = new EscregSDK({
      appId: BigInt(argv.appId),
      algorand,
    });

    // a full dump is long, so quit quietly when a downstream pipe closes early ('| head')
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") process.exit(0);
      throw error;
    });

    const appId = String(argv.appId);
    const resumePath: string | undefined = argv.resume;
    const resumed = resumePath ? readCheckpoint(resumePath, appId) : undefined;

    let legacy = resumed?.legacy ?? 0;
    let packed = resumed?.packed ?? 0;
    let entries = resumed?.entries ?? 0;
    // cursor covering every row written so far, which is what a resumed dump picks up from
    let cursor = resumed?.next;
    let round = resumed?.round;

    // stop between rows rather than mid-write, so the cursor and what stdout holds stay in step
    let interrupted = false;
    const onSignal = () => {
      interrupted = true;
    };
    process.on("SIGINT", onSignal).on("SIGTERM", onSignal);

    // never checkpoint ahead of the rows it covers: a queued write is not on disk yet
    const flush = async () => {
      if (process.stdout.writableNeedDrain) await once(process.stdout, "drain");
    };

    const save = async () => {
      if (!resumePath || !cursor) return;
      await flush();
      writeCheckpoint(resumePath, { appId, next: cursor, round, legacy, packed, entries });
    };

    if (resumed) {
      process.stderr.write(`Resuming after box ${resumed.next}, ${legacy + packed} boxes already dumped\n`);
    }

    // rows go to stdout so the dump can be piped; everything else to stderr
    process.stderr.write(`${bucketHeader}\n`);

    try {
      const pages = sdk.scanBucketPages({ pageSize: argv.pageSize, concurrency: argv.concurrency, next: cursor, debug: argv.debug });

      for await (const page of pages) {
        for (const bucket of page.buckets) {
          process.stdout.write(`${formatBucketRow(bucket)}\n`);
          if (bucket.version === 1) legacy++;
          else packed++;
          entries += bucket.appIds.length;
          cursor = boxCursor(bucket.key);
          if (interrupted) break;
        }

        round = page.round;
        // the page cursor also covers any credit boxes trailing the last bucket
        if (!interrupted && page.next) cursor = page.next;
        if (interrupted || !page.next) break;

        await save();
      }
    } catch (error) {
      // the rows before a failed page are still dumped, so checkpoint them before bailing out
      await save();
      throw error;
    } finally {
      process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
    }

    const boxes = legacy + packed;

    if (interrupted) {
      await save();
      const resumeHint = resumePath ? "Re-run the same command to continue." : "Pass --resume <file> to make a dump resumable.";
      process.stderr.write(`Interrupted after ${boxes} boxes. ${resumeHint}\n`);
      process.exitCode = 130;
      return;
    }

    if (resumePath) clearCheckpoint(resumePath);

    if (!boxes) {
      process.stderr.write("No registry boxes found.\n");
      return;
    }

    process.stderr.write(`${boxes} boxes (${legacy} v1, ${packed} v2), ${entries} app IDs\n`);
  } catch (error) {
    console.error("Error dumping boxes:", (error as Error).message);
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

    const amount = BigInt(parseFloat(argv.amount) * 1e6);

    console.log(`Withdrawing ${argv.amount} Algos from contract ${argv.appId}...`);
    const txId = await sdk.withdraw({ amount, debug: argv.debug });

    console.log("Withdrawal successful!");
    console.log(`Transaction ID: ${txId}`);
  } catch (error) {
    console.error("Error withdrawing funds:", (error as Error).message);
    process.exit(1);
  }
}
