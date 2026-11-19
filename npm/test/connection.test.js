// Tests UmbraConnectionClient against an in-process fake Umbra server. Run `npm run build` first.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const grpc = require("@grpc/grpc-js");
const lib = require("../dist");

const { LumosProtobuf: T, LumosProtobufCommon: S } = lib;
const UMBRA_INFO = T.ClientProgramInfo.fromPartial({ clientInfo: { clientname: "Umbra", runtimeid: "umbra-1", networkid: "net", ips: ["127.0.0.1"] } });

class Queue {
  items = [];
  waiters = [];
  push(x) {
    const w = this.waiters.shift();
    w ? w(x) : this.items.push(x);
  }
  next(ms = 5000) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), ms);
      this.waiters.push((x) => (clearTimeout(t), res(x)));
    });
  }
}

let server, port, umbra, channel, client;

function fakeUmbra() {
  const u = {
    loginCode: T.UmbraLoginResponse_EReturnCode.NoError,
    pongs: new Queue(), broadcastsIn: new Queue(), controlResponses: new Queue(), loggedOff: new Queue(),
    streams: {}, metadata: [],
  };
  u.client = {
    login(call, cb) {
      u.metadata.push(call.metadata.get("x-test")[0]);
      if (u.loginCode === -1) return cb({ code: grpc.status.PERMISSION_DENIED, details: "nope" });
      cb(null, T.UmbraLoginResponse.fromPartial({ returnCode: u.loginCode, sessionId: "sess-1", umbraServer: UMBRA_INFO }));
    },
    logoff(_call, cb) {
      u.loggedOff.push(true);
      cb(null, { bye: "bye" });
    },
  };
  u.connected = {
    ping(call) {
      u.streams.ping = call;
      call.write(T.PingPong.fromPartial({ requestCounter: 99, clientname: "Umbra" }));
      call.on("data", (p) => u.pongs.push(p));
    },
    sendBroadcast(call) {
      u.streams.broadcast = call;
      call.on("data", (m) => u.broadcastsIn.push(m));
    },
    processClientControls(call) {
      u.streams.control = call;
      call.on("data", (r) => u.controlResponses.push(r));
    },
    receiveClientChanges(call) {
      u.streams.changes = call;
    },
    controlClient(call, cb) {
      cb(null, T.ConfirmedResponse.fromPartial({ ok: true, requestId: call.request.source.runtimeid }));
    },
    getClientProgramInfo(call, cb) {
      cb(null, T.UmbraClientProgramInfoResponse.fromPartial({ info: { clientInfo: { runtimeid: call.request.requestId } } }));
    },
    reportReadyToWork(_c, cb) {
      cb(null, T.ConfirmedResponse.fromPartial({ ok: true }));
    },
  };
  u.net = {
    getUmbraNetworkInfo(_c, cb) {
      cb(null, T.UmbraNetworkInfoResponse.fromPartial({ connectedClients: [UMBRA_INFO] }));
    },
    informClientExists(_c, cb) {
      cb(null, T.InformClientExistsResponse.fromPartial({ ok: true, umbra: UMBRA_INFO, requests: [{ targetClientName: "renamed" }] }));
    },
    setClientParameter(_c, cb) {
      cb(null, T.ConfirmedResponse.fromPartial({ ok: true }));
    },
  };
  return u;
}

async function waitUntil(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  umbra = fakeUmbra();
  server = new grpc.Server();
  server.addService(S.ClientServiceService, umbra.client);
  server.addService(S.ConnectedClientServiceService, umbra.connected);
  server.addService(S.DMXCNetServiceService, umbra.net);
  port = await new Promise((res, rej) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));

  channel = lib.createUmbraChannel("127.0.0.1", port);
  const md = new grpc.Metadata();
  md.set("x-test", "1");
  client = new lib.UmbraConnectionClient({
    umbraChannel: channel,
    createChannel: (host) => lib.createUmbraChannel(host, port),
    hostMetadata: md,
    clientProgramInfo: T.ClientProgramInfo.fromPartial({ clientInfo: { clientname: "Tester", runtimeid: "me", networkid: "net" } }),
    clientname: "Tester",
    networkID: "net",
  });
});

afterEach(async () => {
  await client.disconnect();
  channel.close();
  server.forceShutdown();
});

test("login, streams and unary helpers", async () => {
  const resp = await client.connect();
  assert.equal(resp.sessionId, "sess-1");
  assert.equal(client.sessionID, "sess-1");
  assert.equal(client.connectedToUmbra.clientInfo.runtimeid, "umbra-1");
  assert.deepEqual(umbra.metadata, ["1"]);

  const pongs = [await umbra.pongs.next(), await umbra.pongs.next()];
  assert.ok(pongs.some((p) => p.requestCounter === 1 && p.clientname === "Tester"));
  assert.ok(pongs.some((p) => p.requestCounter === 99 && p.responder === "Tester"));

  // broadcasts both directions
  const received = new Queue();
  client.on("broadcastReceived", (a) => received.push(a.message));
  assert.ok(client.sendBroadcast(T.BroadcastMessage.fromPartial({})));
  await umbra.broadcastsIn.next();
  await waitUntil(() => umbra.streams.broadcast);
  umbra.streams.broadcast.write(T.BroadcastMessage.fromPartial({}));
  await received.next();

  // client control with an async listener
  client.on("clientControlRequestReceived", async (args) => {
    await new Promise((r) => setTimeout(r, 10));
    args.processed = true;
    args.ok = true;
    args.message = "done";
  });
  await waitUntil(() => umbra.streams.control);
  umbra.streams.control.write(T.ClientControlRequest.fromPartial({ requestId: "r1" }));
  const r = await umbra.controlResponses.next();
  assert.equal(r.requestId, "r1");
  assert.equal(r.ok, true);
  assert.equal(lib.translateableToFormattedString(r.message), "done");

  // client changes
  const changes = new Queue();
  client.on("umbraUserChanged", (e) => changes.push(e));
  await waitUntil(() => umbra.streams.changes);
  umbra.streams.changes.write(T.UmbraClientInfoMessage.fromPartial({ client: UMBRA_INFO, login: true }));
  const ev = await changes.next();
  assert.equal(ev.login, true);
  assert.equal(ev.client.clientname, "Umbra");

  assert.deepEqual((await client.getUmbraUsers()).map((u) => u.runtimeid), ["umbra-1"]);
  assert.equal((await client.getClientProgramInfo("abc")).clientInfo.runtimeid, "abc");
  assert.equal((await client.sendClientControlRequest(T.ClientControlRequest.fromPartial({ controlClientRuntimeId: "other" }))).requestId, "me");
  await assert.rejects(client.sendClientControlRequest(T.ClientControlRequest.fromPartial({ controlClientRuntimeId: "me" })));
  await client.reportReadyToWork(T.ReadyToWorkState.fromPartial({ readyToWork: true }));

  await client.disconnect();
  await umbra.loggedOff.next();
  assert.equal(client.sessionID, undefined);
  assert.equal(client.sendBroadcast(T.BroadcastMessage.fromPartial({})), false);
});

test("unanswered client control request", async () => {
  await client.connect();
  await waitUntil(() => umbra.streams.control);
  umbra.streams.control.write(T.ClientControlRequest.fromPartial({ requestId: "r1" }));
  const r = await umbra.controlResponses.next();
  assert.equal(r.ok, false);
  assert.equal(r.message.formatString, "Not processed");

  client.on("clientControlRequestReceived", () => new Promise((res) => setTimeout(res, 1500)));
  umbra.streams.control.write(T.ClientControlRequest.fromPartial({ requestId: "r2" }));
  const r2 = await umbra.controlResponses.next();
  assert.equal(r2.message.formatString, "Timeout");
});

test("login failures", async () => {
  umbra.loginCode = T.UmbraLoginResponse_EReturnCode.ClientLimitReached;
  await assert.rejects(client.connect(), (e) => e instanceof lib.LoginException && e.returnCode === T.UmbraLoginResponse_EReturnCode.ClientLimitReached);
  umbra.loginCode = -1;
  await assert.rejects(client.connect(), (e) => e instanceof lib.LoginException && e.returnCode === T.UmbraLoginResponse_EReturnCode.AccessDenied);
  assert.equal(client.sessionID, undefined);
});

test("connection lost", async () => {
  let lost = false;
  client.on("connectionLost", () => (lost = true));
  await client.connect();
  await umbra.pongs.next();
  server.forceShutdown();
  await waitUntil(() => lost, 10000);
});

test("discovery broadcast triggers autoconnect", async () => {
  const requests = [];
  const targets = [];
  const info = T.ClientProgramInfo.fromPartial({ ...UMBRA_INFO, clientInfo: { ...UMBRA_INFO.clientInfo, umbraPort: port } });
  await client.processDiscoveryBroadcast(
    { broadcast: T.UmbraUdpBroadcast.fromPartial({ umbraServer: info }), endPoint: { address: "127.0.0.1", port: 17474 } },
    (r) => requests.push(...r),
    async (host, p) => {
      targets.push([host, p]);
      await client.connect();
      return lib.EAutoconnectResult.OK;
    },
    ["127.0.0.1"],
  );
  assert.deepEqual(requests.map((r) => r.targetClientName), ["renamed"]);
  assert.deepEqual(targets, [["127.0.0.1", port]]);
  assert.equal(client.sessionID, "sess-1");
});

test("discovery client receives UDP broadcasts", async () => {
  const d = new lib.UmbraDiscoveryClient();
  const got = new Queue();
  d.on("umbraDiscoveryBroadcastReceived", (a) => got.push(a));
  await d.startDiscovery([]);
  try {
    const s = dgram.createSocket("udp4");
    const bc = T.UmbraUdpBroadcast.encode(T.UmbraUdpBroadcast.fromPartial({ umbraServer: UMBRA_INFO })).finish();
    await new Promise((r) => s.send(Buffer.from([0xff, 0xff, 1]), lib.NetConstants.DMXCNET_MULTICAST_PORT, "127.0.0.1", r));
    await new Promise((r) => s.send(bc, lib.NetConstants.DMXCNET_MULTICAST_PORT, "127.0.0.1", r));
    s.close();
    const a = await got.next();
    assert.equal(a.broadcast.umbraServer.clientInfo.clientname, "Umbra");
    assert.equal(a.broadcast.sourceEndPoint, "127.0.0.1");
    assert.equal(d.getBroadcastHistory(true, 0).length, 1);
  } finally {
    d.dispose();
  }
});
