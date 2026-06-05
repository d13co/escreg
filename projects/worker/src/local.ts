/**
 * Standalone local runner for the escreg watcher — a backup that runs the same
 * discovery/registration logic as the Cloudflare Worker, but on a plain server
 * with its own independent cursor file (no Cloudflare KV).
 *
 * Reuses the worker's `watcher.ts` verbatim; only the `STATE` binding is swapped
 * for a file-backed store (see `store.ts`).
 *
 * Usage:
 *   tsx src/local.ts run                 # loop forever, one pass every INTERVAL_MS
 *   tsx src/local.ts tick                # run a single pass and exit (for system cron)
 *   tsx src/local.ts seed <network> <id> # initialise a cursor (use --force to overwrite)
 *   tsx src/local.ts status              # print current cursors and exit
 *
 * Config (env vars, optionally loaded from a .dev.vars file in the cwd):
 *   MNEMONIC      account mnemonic for signing (required to register)
 *   SENDER        optional sender address override (for rekeyed accounts)
 *   INDEXER_TOKEN optional indexer API token (X-Indexer-API-Token header)
 *   STATE_FILE    cursor file path (default: ./.local-state/cursors.json)
 *   INTERVAL_MS   poll interval for `run` (default: 60000)
 */
import { readFileSync } from "node:fs";
import { NETWORK_NAMES, type NetworkName } from "./networks";
import {
  type Env,
  pollAllNetworks,
  registerBatch,
  advanceCursors,
  getCursor,
  setCursor,
} from "./watcher";
import { FileStore } from "./store";

/** Load KEY=VALUE pairs from a .dev.vars file into process.env (without clobbering). */
function loadDotVars(path = ".dev.vars"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // file is optional
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function buildEnv(store: FileStore): Env {
  return {
    STATE: store as unknown as KVNamespace,
    MNEMONIC: process.env.MNEMONIC ?? "",
    SENDER: process.env.SENDER,
    INDEXER_TOKEN: process.env.INDEXER_TOKEN,
  };
}

/** One pass of the watcher loop — mirrors the Worker's `scheduled()` handler. */
async function runTick(env: Env): Promise<void> {
  if (!env.MNEMONIC) {
    console.warn("MNEMONIC not configured, skipping");
    return;
  }

  const { allAppIds, cursors } = await pollAllNetworks(env);

  if (allAppIds.length === 0) {
    console.log(`[${new Date().toISOString()}] no new apps`);
    return;
  }

  console.log(`Discovered ${allAppIds.length} new apps, registering...`);
  const txIds = await registerBatch(env, allAppIds);
  console.log(`Registered ${allAppIds.length} apps in ${txIds.length} txns`);

  await advanceCursors(env, cursors);
  console.log("Cursors advanced:", cursors);
}

async function cmdRun(env: Env): Promise<void> {
  const interval = Number(process.env.INTERVAL_MS) || 60_000;
  console.log(`Starting watcher loop, every ${interval}ms. Ctrl-C to stop.`);

  let running = false;
  let stopping = false;

  const tick = async () => {
    if (running || stopping) return; // never overlap passes
    running = true;
    try {
      await runTick(env);
    } catch (err) {
      console.error("Tick failed:", err);
    } finally {
      running = false;
    }
  };

  await tick();
  const handle = setInterval(tick, interval);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} received, shutting down.`);
      stopping = true;
      clearInterval(handle);
      // let any in-flight pass finish (writes are atomic regardless)
      const wait = setInterval(() => {
        if (!running) {
          clearInterval(wait);
          process.exit(0);
        }
      }, 100);
    });
  }
}

async function cmdSeed(store: FileStore, args: string[]): Promise<void> {
  const force = args.includes("--force");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [network, appId] = positional;

  if (!network || !appId) {
    console.error("Usage: seed <network> <appId> [--force]");
    process.exit(2);
  }
  if (!NETWORK_NAMES.includes(network as NetworkName)) {
    console.error(`Unknown network: ${network}. Known: ${NETWORK_NAMES.join(", ")}`);
    process.exit(2);
  }
  if (!/^\d+$/.test(appId)) {
    console.error(`appId must be a positive integer, got: ${appId}`);
    process.exit(2);
  }

  const env = buildEnv(store);
  const existing = await getCursor(env, network as NetworkName);
  if (existing !== null && !force) {
    console.error(
      `Cursor already set for ${network} (${existing}). Pass --force to overwrite.`,
    );
    process.exit(1);
  }

  await setCursor(env, network as NetworkName, appId);
  console.log(`Seeded ${network} cursor at ${appId}`);
}

async function cmdStatus(store: FileStore): Promise<void> {
  const env = buildEnv(store);
  const status: Record<string, string | null> = {};
  for (const network of NETWORK_NAMES) {
    status[network] = await getCursor(env, network);
  }
  console.log(JSON.stringify(status, null, 2));
}

async function main(): Promise<void> {
  loadDotVars();

  const statePath = process.env.STATE_FILE ?? "./.local-state/cursors.json";
  const store = new FileStore(statePath);

  const [command, ...rest] = process.argv.slice(2);

  switch (command ?? "run") {
    case "run":
      await cmdRun(buildEnv(store));
      break;
    case "tick":
      await runTick(buildEnv(store));
      break;
    case "seed":
      await cmdSeed(store, rest);
      break;
    case "status":
      await cmdStatus(store);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Commands: run | tick | seed <network> <appId> | status");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
