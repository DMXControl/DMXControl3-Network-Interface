// Tests UmbraConnectionClient against an in-process fake Umbra speaking gRPC-Web. Run `npm run build` first.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as lib from "../dist/index.js";
import { startGrpcWebServer } from "./grpcWebServer.js";

const { LumosProtobuf: T, LumosProtobufCommon: S, Metadata, Status } = lib;
const UMBRA_INFO = { clientInfo: { clientname: "Umbra", runtimeid: "umbra-1", networkid: "net", ips: ["127.0.0.1"] } };

class Queue {
  items = [];
  waiters = [];
  push(x) {
    const w = this.waiters.shift();
    w ? w(x) : this.items.push(x);
  }
  next(ms) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (ms === undefined) return new Promise((res) => this.waiters.push(res));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), ms);
      this.waiters.push((x) => (clearTimeout(t), res(x)));
    });
  }
}

let server, umbra, client;

function fakeUmbra() {
  const u = {
    loginCode: T.UmbraLoginResponse_EReturnCode.NoError,
    loginError: undefined,
    pingError: undefined,
    pings: new Queue(), loggedOff: new Queue(), changeStreams: new Queue(), metadata: [],
    changes: new Queue(),
  };
  u.client = {
    async login(_req, call) {
      u.metadata.push(call.headers["x-test"]);
      if (u.loginError) throw u.loginError;
      return { returnCode: u.loginCode, sessionId: "sess-1", umbraServer: UMBRA_INFO };
    },
    async logoff(_req, call) {
      u.loggedOff.push(call.headers.sessionid);
      return { bye: "bye" };
    },
  };
  // like the real Umbra: connected services need the session ID from the login
  const session = (call) => {
    if (call.headers.sessionid !== "sess-1") throw { code: Status.INVALID_ARGUMENT, details: "SessionID missing in Headers" };
  };
  u.connected = {
    async pingUnary(req, call) {
      u.pings.push(req);
      session(call);
      if (u.pingError) throw u.pingError;
      return { requestCounter: req.requestCounter, clientname: "Umbra", responder: "Umbra" };
    },
    async *receiveClientChanges(_req, call) {
      session(call);
      u.changeStreams.push(call.signal);
      const aborted = new Promise((r) => call.signal.addEventListener("abort", () => r(null), { once: true }));
      while (!call.signal.aborted) {
        const msg = await Promise.race([u.changes.next(), aborted]);
        if (msg === null) return;
        if (msg instanceof Error) throw msg;
        yield msg;
      }
    },
    async controlClient(req, call) {
      session(call);
      return { ok: true, requestId: req.source.runtimeid };
    },
    async getClientProgramInfo(req, call) {
      session(call);
      return { info: { clientInfo: { runtimeid: req.requestId } } };
    },
    async reportReadyToWork(req, call) {
      session(call);
      u.ready = req.state;
      return { ok: true };
    },
  };
  u.net = {
    async getUmbraNetworkInfo() {
      return { connectedClients: [UMBRA_INFO] };
    },
  };
  return u;
}

function newClient(port) {
  const md = new Metadata();
  md.set("x-test", "1");
  return new lib.UmbraConnectionClient({
    umbraChannel: lib.createUmbraChannel("127.0.0.1", port),
    hostMetadata: md,
    clientProgramInfo: T.ClientProgramInfo.fromPartial({ clientInfo: { clientname: "Tester", runtimeid: "me", networkid: "net" } }),
    clientname: "Tester",
  });
}

beforeEach(async () => {
  umbra = fakeUmbra();
  server = await startGrpcWebServer([
    [S.ClientServiceDefinition, umbra.client],
    [S.ConnectedClientServiceDefinition, umbra.connected],
    [S.DMXCNetServiceDefinition, umbra.net],
  ]);
  client = newClient(server.port);
});

afterEach(async () => {
  await client.disconnect();
  await server.close();
});

test("connect logs in, sends metadata and pings", async () => {
  const res = await client.connect();
  assert.equal(res.sessionId, "sess-1");
  assert.equal(client.sessionID, "sess-1");
  assert.equal(client.connectedToUmbra.clientInfo.runtimeid, "umbra-1");
  assert.deepEqual(umbra.metadata, ["1"]);

  const ping = await umbra.pings.next(5000);
  assert.equal(ping.clientname, "Tester");
  assert.equal(ping.requestCounter, 1);
});

test("login failures throw LoginException", async () => {
  umbra.loginCode = T.UmbraLoginResponse_EReturnCode.Error;
  await assert.rejects(client.connect(false), (e) => e instanceof lib.LoginException && e.returnCode === T.UmbraLoginResponse_EReturnCode.Error);

  umbra.loginError = { code: Status.PERMISSION_DENIED, details: "nope" };
  await assert.rejects(client.connect(false), (e) => e instanceof lib.LoginException && e.returnCode === T.UmbraLoginResponse_EReturnCode.AccessDenied && e.message === "nope");
  assert.equal(client.sessionID, undefined);
});

test("unreachable server throws LoginException", async () => {
  await server.close();
  await assert.rejects(client.connect(false), (e) => e instanceof lib.LoginException && e.returnCode === T.UmbraLoginResponse_EReturnCode.Error);
});

test("abort signal cancels connect", async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(client.connect(false, c.signal), { name: "AbortError" });
});

test("two failed pings emit connectionLost", async () => {
  umbra.pingError = { code: Status.UNAVAILABLE, details: "down" };
  const lost = new Promise((r) => client.once("connectionLost", r));
  await client.connect();
  await lost;
  await umbra.pings.next(5000);
  await umbra.pings.next(5000);
});

test("client changes are emitted", async () => {
  const events = new Queue();
  client.on("umbraUserChanged", (e) => events.push(e));
  await client.connect();
  await umbra.changeStreams.next(5000);

  umbra.changes.push({ login: true, client: { clientInfo: { clientname: "Other" } } });
  let e = await events.next(5000);
  assert.equal(e.client.clientname, "Other");
  assert.equal(e.login, true);

  umbra.changes.push({ logoff: T.ELogoffReason.ELogoffReason_Unknown, client: { clientInfo: {} } }); // ignored
  umbra.changes.push({ logoff: T.ELogoffReason.ClientLogoff, client: { clientInfo: { clientname: "Other" } } });
  e = await events.next(5000);
  assert.equal(e.logoff, true);
});

test("client change stream restarts after UNKNOWN", async () => {
  await client.connect();
  await umbra.changeStreams.next(5000);
  umbra.changes.push(Object.assign(new Error("boom"), { code: Status.UNKNOWN, details: "boom" }));
  await umbra.changeStreams.next(5000);
});

test("disconnect logs off and closes the stream", async () => {
  await client.connect();
  const signal = await umbra.changeStreams.next(5000);
  await client.disconnect();
  assert.equal(await umbra.loggedOff.next(5000), "sess-1");
  assert.equal(client.sessionID, undefined);
  await new Promise((r) => (signal.aborted ? r() : signal.addEventListener("abort", r)));
});

test("unary helpers", async () => {
  await client.connect(false);
  await client.reportReadyToWork({ readyToWork: true, receiveAndDisplayMessages: false });
  assert.equal(umbra.ready.readyToWork, true);

  const users = await client.getUmbraUsers();
  assert.equal(users[0].runtimeid, "umbra-1");

  const info = await client.getClientProgramInfo("abc");
  assert.equal(info.clientInfo.runtimeid, "abc");

  const r = await client.sendClientControlRequest(T.ClientControlRequest.fromPartial({ controlClientRuntimeId: "other" }));
  assert.equal(r.requestId, "me");
  await assert.rejects(client.sendClientControlRequest(T.ClientControlRequest.fromPartial({ controlClientRuntimeId: "me" })));
});
