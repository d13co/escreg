import { mnemonicToSecretKey, makeBasicAccountTransactionSigner, Address } from "algosdk";
import { EscregSDK } from "@d13co/escreg-sdk";
import type { NetworkName } from "./networks";
import { NETWORK_NAMES, indexerUrl } from "./networks";

export interface Env {
  STATE: KVNamespace;
  MNEMONIC: string;
  SENDER?: string;
  INDEXER_TOKEN?: string;
}

interface PollResult {
  appIds: bigint[];
  nextToken: string | null;
}

function kvKey(network: NetworkName): string {
  return `cursor:${network}`;
}

export async function getCursor(env: Env, network: NetworkName): Promise<string | null> {
  return env.STATE.get(kvKey(network));
}

export async function setCursor(env: Env, network: NetworkName, appId: string): Promise<void> {
  await env.STATE.put(kvKey(network), appId);
}

/** Poll a single page of new applications from the indexer. */
export async function pollNetwork(
  indexerUrl: string,
  lastAppId: string | null,
  token?: string,
): Promise<PollResult> {
  const url = new URL(`${indexerUrl}/v2/applications`);
  url.searchParams.set("limit", "500");
  if (lastAppId) {
    url.searchParams.set("next", lastAppId);
  }

  const headers = token ? { "X-Indexer-API-Token": token } : undefined;
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`Indexer ${indexerUrl} returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    applications: { id: number }[];
    "next-token"?: string;
  };

  const appIds = data.applications.map((app) => BigInt(app.id));
  const nextToken = data["next-token"] ?? null;

  return { appIds, nextToken };
}

/** Poll all networks and return discovered app IDs + updated cursors. */
export async function pollAllNetworks(
  env: Env,
): Promise<{ allAppIds: bigint[]; cursors: Record<string, string> }> {
  const allAppIds: bigint[] = [];
  const cursors: Record<string, string> = {};

  const hasToken = Boolean(env.INDEXER_TOKEN);

  // Each network is polled independently and catches its own errors, so one
  // network's indexer being down never aborts the others.
  const results = await Promise.all(
    NETWORK_NAMES.map(async (network) => {
      try {
        const lastAppId = await getCursor(env, network);
        const { appIds, nextToken } = await pollNetwork(
          indexerUrl(network, hasToken),
          lastAppId,
          env.INDEXER_TOKEN,
        );
        // nextToken is the last app ID on the page, use it as the new cursor
        const newCursor =
          appIds.length > 0 ? (nextToken ?? appIds[appIds.length - 1].toString()) : null;
        return { network, appIds, newCursor };
      } catch (err) {
        console.error(`[${network}] poll failed:`, err);
        return { network, appIds: [] as bigint[], newCursor: null };
      }
    }),
  );

  for (const { network, appIds, newCursor } of results) {
    if (appIds.length > 0 && newCursor) {
      console.log(`[${network}] discovered ${appIds.length} new apps (cursor -> ${newCursor})`);
      allAppIds.push(...appIds);
      cursors[network] = newCursor;
    }
  }

  return { allAppIds, cursors };
}

/** Register a batch of app IDs via @d13co/escreg-sdk. */
export async function registerBatch(env: Env, appIds: bigint[]): Promise<string[]> {
  const account = mnemonicToSecretKey(env.MNEMONIC);
  const addr = env.SENDER ? Address.fromString(env.SENDER) : account.addr;
  const writerAccount = {
    addr,
    signer: makeBasicAccountTransactionSigner(account),
  };

  const sdk = new EscregSDK({ writerAccount });

  return sdk.register({ appIds });
}

/** Update cursors in KV after successful registration. */
export async function advanceCursors(
  env: Env,
  cursors: Record<string, string>,
): Promise<void> {
  const results = await Promise.allSettled(
    Object.entries(cursors).map(([network, cursor]) =>
      setCursor(env, network as NetworkName, cursor),
    ),
  );
  results.forEach((result, i) => {
    const [network, cursor] = Object.entries(cursors)[i];
    if (result.status === "rejected") {
      console.error(`[${network}] failed to advance cursor to ${cursor}:`, result.reason);
    } else {
      console.log(`[${network}] cursor advanced to ${cursor}`);
    }
  });
}
