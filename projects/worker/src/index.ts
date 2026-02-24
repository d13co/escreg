import { NETWORK_NAMES, type NetworkName } from "./networks";
import { type Env, pollAllNetworks, registerBatch, advanceCursors, getCursor, setCursor } from "./watcher";

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.MNEMONIC) {
      console.warn("MNEMONIC not configured, skipping");
      return;
    }

    const { allAppIds, cursors } = await pollAllNetworks(env);

    if (allAppIds.length === 0) {
      return;
    }

    console.log(`Discovered ${allAppIds.length} new apps, registering...`);

    const txIds = await registerBatch(env, allAppIds);
    console.log(`Registered ${allAppIds.length} apps in ${txIds.length} txns`);

    await advanceCursors(env, cursors);
    console.log("Cursors advanced:", cursors);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      const status: Record<string, string | null> = {};
      await Promise.all(
        NETWORK_NAMES.map(async (network) => {
          status[network] = await getCursor(env, network);
        }),
      );
      return Response.json(status);
    }

    const startMatch = url.pathname.match(/^\/start\/(\w+)$/);
    if (startMatch && request.method === "POST") {
      const network = startMatch[1] as NetworkName;
      if (!NETWORK_NAMES.includes(network)) {
        return Response.json({ error: `Unknown network: ${network}` }, { status: 400 });
      }

      const appId = url.searchParams.get("appId");
      if (!appId) {
        return Response.json({ error: "Missing ?appId= parameter" }, { status: 400 });
      }
      const existing = await getCursor(env, network);
      if (existing !== null) {
        return Response.json(
          { error: `Cursor already set for ${network} (${existing}). Delete the key first to reset.` },
          { status: 409 },
        );
      }

      await setCursor(env, network, appId);
      return Response.json({ ok: true, network, cursor: appId });
    }

    return new Response("Not found", { status: 404 });
  },
};
