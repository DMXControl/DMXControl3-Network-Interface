// Opt-in test against a running DMXControl 3 Umbra (not part of `npm test`):
//
//   UMBRA_HOST=127.0.0.1 UMBRA_PORT=17476 npm run test:live
//
// Logs in as an ExternalTool, pings, listens for client changes and logs off again. It only
// makes read-only calls (no client control requests, no ready-to-work report).
//
// Umbra's secure port only speaks HTTP/2 and uses a self-signed certificate. Browsers
// negotiate HTTP/2 themselves; Node's fetch needs an undici dispatcher with allowH2, and
// certificate checks are disabled here (UMBRA_INSECURE=0 to keep them).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Agent, setGlobalDispatcher } from "undici";
import * as lib from "../../dist/index.js";

const host = process.env.UMBRA_HOST ?? "127.0.0.1";
const port = Number(process.env.UMBRA_PORT ?? lib.NetConstants.UMBRA_LISTEN_PORT_SECURE);
setGlobalDispatcher(new Agent({ allowH2: true, connect: { rejectUnauthorized: process.env.UMBRA_INSECURE === "0" } }));

const { LumosProtobuf: T, LumosProtobufCommon: S } = lib;
const log = (...a) => console.log("   ", ...a);

test(`live Umbra at https://${host}:${port}`, async (t) => {
  const channel = lib.createUmbraChannel(host, port, true);

  const net = lib.createClient(S.DMXCNetServiceDefinition, channel);
  const info = await net.getUmbraNetworkInfo({});
  const umbraInfo = info.connectedClients.find((c) => c.clientInfo?.type === T.EClientType.Umbra)?.clientInfo;
  log(`network info: ${info.connectedClients.length} clients:`, info.connectedClients.map((c) => `${c.clientInfo?.clientname} (${T.eClientTypeToJSON(c.clientInfo?.type ?? 0)})`).join(", "));

  const runtimeid = randomUUID();
  const clientname = "npm-web live test";
  const client = new lib.UmbraConnectionClient({
    umbraChannel: channel,
    hostMetadata: new lib.Metadata(),
    clientProgramInfo: T.ClientProgramInfo.fromPartial({
      clientInfo: { clientname, runtimeid, hostname: "npm-web-test", type: T.EClientType.ExternalTool, networkid: umbraInfo?.networkid ?? "" },
    }),
    clientname,
  });
  client.logger = { debug: log, info: log, warn: log, error: log };

  let lost = false;
  client.on("connectionLost", () => (lost = true));
  const changes = [];
  client.on("umbraUserChanged", (e) => changes.push(e));

  try {
    await t.test("login", async () => {
      const res = await client.connect();
      log(`login: ${T.umbraLoginResponse_EReturnCodeToJSON(res.returnCode)}, session ${res.sessionId}, umbra ${res.umbraServer?.clientInfo?.clientname}`);
      assert.ok(client.sessionID);
    });

    await t.test("our login shows up in the users and the client change stream", async () => {
      const users = await client.getUmbraUsers();
      assert.ok(users.some((u) => u.runtimeid === runtimeid), "own client not in getUmbraUsers");
      const pi = await client.getClientProgramInfo(runtimeid);
      log(`getClientProgramInfo(self): ${pi?.clientInfo?.clientname}`);
    });

    await t.test("PingUnary keeps the session alive for 12 s", async () => {
      await new Promise((r) => setTimeout(r, 12_000));
      assert.equal(lost, false, "connectionLost was emitted");
      assert.ok((await client.getUmbraUsers()).some((u) => u.runtimeid === runtimeid), "dropped by Umbra");
    });

    await t.test("gRPC errors come back as ClientError", async () => {
      // without the session header, Umbra answers INVALID_ARGUMENT (a trailers-only response)
      const connected = lib.createClient(S.ConnectedClientServiceDefinition, channel);
      const err = await connected.pingUnary({ clientname }).then(() => undefined, (e) => e);
      log(`call without session: ${err?.constructor?.name} ${lib.Status[err?.code]}: ${err?.details}`);
      assert.ok(err instanceof lib.ClientError);
      assert.equal(err.code, lib.Status.INVALID_ARGUMENT);
    });
  } finally {
    await client.disconnect();
    log(`client changes received: ${changes.map((e) => `${e.client.clientname} ${e.login ? "login" : e.logoff ? "logoff" : "update"}`).join(", ") || "none"}`);
  }

  const after = await net.getUmbraNetworkInfo({});
  log("after logoff:", after.connectedClients.map((c) => `${c.clientInfo?.clientname} ${c.clientInfo?.runtimeid}`).join(", "));
  assert.ok(!after.connectedClients.some((c) => c.clientInfo?.runtimeid === runtimeid), "still listed after logoff");
});
