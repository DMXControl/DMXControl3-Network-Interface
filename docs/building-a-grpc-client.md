# Building a gRPC client for DMXControl 3

This guide explains how to write a program that connects to a DMXControl 3 (DMXC) server over gRPC, using the protos and packages in this repository. It covers the connection flow every client has to follow and shows how to do it with the helpers in each package.

The DMXC server side is called **Umbra**. It is a broker: your program is a client of Umbra, and Umbra forwards calls to the domain services (executors, macros, cuelists, devices, …).

## Choosing a package

| You write… | Use | Helpers |
| --- | --- | --- |
| C# / .NET | NuGet `DMXControl3-Network-Interface` ([`csharp/`](../csharp)) | `UmbraConnectionClient`, `UmbraDiscoveryClient`, `NetConstants` |
| Node.js (TypeScript / JavaScript) | npm `@dmxcontrolprojects/dmxcontrol3-network-interface` ([`npm/`](../npm)) | same, ported to TypeScript |
| Browser (gRPC-Web) | npm `@dmxcontrolprojects/dmxcontrol3-network-interface-web` ([`npm-web/`](../npm-web)) | `UmbraConnectionClient` without discovery, broadcasts or client control |
| Python | PyPI `dmxcontrol3-network-interface`, import `dmxc_protobuf` ([`python/`](../python/dmxc_protobuf)) | same, ported to `grpc.aio` |
| Any other language | Generate stubs from [`proto/`](../proto) with `protoc` | none, follow the steps below by hand |

The helpers do discovery, login, logoff and the mandatory keepalive for you. You still have to bind a user and call the domain services yourself.

## Connection flow

```
 ┌──────────────┐  1. UDP multicast discovery (225.68.67.3:17474)  ┌──────────────┐
 │              │ ◀─────────────────────────────────────────────── │              │
 │              │  2. ClientService/Login            → SessionID   │              │
 │              │ ───────────────────────────────────────────────▶ │              │
 │  Your client │  3. ConnectedClientService/ReportReadyToWork     │    Umbra     │
 │              │  4. ConnectedClientService/Ping  (bidi stream)   │ (DMXC server)│
 │              │  5. UserClient/Bind              (user context)  │  port 17475  │
 │              │  6. Domain services (Executor, Macro, Cuelist…)  │              │
 │              │ ───────────────────────────────────────────────▶ │              │
 │              │  7. ClientService/Logoff                         │              │
 └──────────────┘                                                  └──────────────┘
```

Every call after the login must carry the metadata header `SessionID: <id>`. gRPC lowercases header names, so Umbra receives it as `sessionid`. Without it, Umbra answers `INVALID_ARGUMENT` ("SessionID missing in Headers").

## Constants

From `NetConstants` (all packages):

| Constant | Value | Purpose |
| --- | --- | --- |
| `DMXCNET_MULTICAST_ADDRESS` | `225.68.67.3` | Multicast group for discovery broadcasts |
| `DMXCNET_MULTICAST_PORT` | `17474` | UDP port for discovery |
| `UMBRA_LISTEN_PORT` | `17475` | gRPC port of Umbra, plaintext HTTP/2 (h2c) |
| `UMBRA_LISTEN_PORT_SECURE` | `17476` | gRPC port of Umbra over TLS (self-signed certificate, `CN=umbra.tld`). Required for gRPC-Web. |
| `MAX_MESSAGE_SIZE` | 50 MB | Maximum gRPC message size. Set it as the send and receive limit on your channel. |
| `MAX_RESOURCE_DIRECT_SEND_SIZE` | 5 MB | Largest file sent directly as `bytes` |

`createUmbraChannel` (Node, web) and `create_umbra_channel` (Python) create a channel with the message size limits already set. Node and Python default to plaintext on port 17475.

## Where the services are

| Proto | Package | Contents |
| --- | --- | --- |
| [`proto/Common/UmbraClientService.proto`](../proto/Common/UmbraClientService.proto) | `LumosProtobufCommon` | `ClientService` (login/logoff), `ConnectedClientService` (ready, ping, broadcasts, client control), `DMXCNetService` (discovery helpers) |
| [`proto/Common/Types/UmbraServiceTypes.proto`](../proto/Common/Types/UmbraServiceTypes.proto) | `LumosProtobuf` | `UmbraUdpBroadcast`, `ClientProgramInfo`, `ClientInfo`, `UmbraLoginRequest`, `PingPong`, … |
| [`proto/Common/Types/CommonTypes.proto`](../proto/Common/Types/CommonTypes.proto) | `LumosProtobuf` | `GetRequest`, `GetMultipleRequest`, `ConfirmedResponse`, `EChangeType` |
| [`proto/Client/*.proto`](../proto/Client) | `LumosProtobufClient` | Domain services: `UserClient`, `ExecutorClient`, `MacroClient`, `CuelistClient`, `DeviceClient`, … |
| [`proto/Common/Types/**`](../proto/Common/Types) | `LumosProtobuf.<Area>` | Request and response messages of the domain services |

In C#, `LumosProtobufCommon` services live in the `UmbraCommon` namespace and `LumosProtobufClient` services in `UmbraClient`. In Python, the module path follows the proto path, e.g. `dmxc_protobuf.Client.MacroClient_pb2_grpc`.

## 1. Discovering the server

DMXC servers announce themselves over UDP multicast. To receive the announcements:

1. Bind a UDP4 socket to `0.0.0.0:17474` with address reuse enabled, because other DMXC programs on the same machine bind the same port.
2. Join the multicast group `225.68.67.3` on each local IPv4 interface.
3. Decode each datagram as `LumosProtobuf.UmbraUdpBroadcast`.

From the broadcast:

- `umbraServer.clientInfo.networkid`: the server's Net ID (the DMXC "project network").
- `umbraServer.clientInfo.umbraPort`: the gRPC port (fall back to 17475).
- `umbraServer.clientInfo.ips`: every IP of the server. The sender address of the datagram is usually the best one to try first.

Pick the server whose Net ID matches the one you want to join, and connect to `ip:umbraPort`.

`UmbraDiscoveryClient` does steps 1–3 and raises an event per broadcast (C# `UmbraDiscoveryBroadcastReceived`, Node `umbraDiscoveryBroadcastReceived`, Python `umbra_discovery_broadcast_received`). Pass the event to `UmbraConnectionClient.processDiscoveryBroadcast` / `process_discovery_broadcast` / `ProcessDiscoveryBroadcast`: it informs the server that your client exists, tries the server's IPs (localhost first if the server runs on the same machine), and calls your autoconnect callback when the Net ID matches.

You can skip discovery by connecting straight to a known `host:17475`. Browsers cannot use UDP, so gRPC-Web clients always connect to a known host.

### Making yourself visible to other networks (optional)

Call `DMXCNetService/InformClientExists` with your `ClientProgramInfo` on servers whose Net ID doesn't match. The DMXC GUI then lists your client so a user can assign it to a network. The response's `requests[]` (`SetNetworkPropertyRequest`) may contain a new Net ID or client name. Save them, so the next matching broadcast connects. `processDiscoveryBroadcast` does this and hands the requests to your `processRequests` callback.

## 2. Logging in

Call `ClientService/Login` with an `UmbraLoginRequest` holding a `ClientProgramInfo` that describes your program:

```
ClientProgramInfo {
  programInfo: ProgramInfo { programName, programVersion, vendor, buildDate }
  clientInfo: ClientInfo {
    hostname:           the machine's host name           (required)
    ips:                all non-internal IPv4 addresses
    type:               EClientType.ExternalTool          (required)
    clientname:         a display name, e.g. "My Tool"
    clientCapabilities: 0
    runtimeid:          a UUID generated once per process run
    networkid:          the Net ID to join                (required, may be empty)
  }
  clientTimestampUTC: now
}
```

- Without `hostname`, `type` and `networkid`, Umbra answers `InvalidLoginData`.
- Generate `runtimeid` once at startup and keep it for every reconnect during that run, so Umbra recognizes the client.
- Send `Login` without a session header.

Check `UmbraLoginResponse.returnCode`. `NoError` and `AlreadyLoggedIn` mean success. Anything else (`AccessDenied`, `InvalidLoginData`, …) is a failure, and `message` says why. On success, keep `sessionId` and send it as the `SessionID` header on every later call.

The helpers' `connect()` does the login, checks the return code (throwing `LoginException` otherwise), stores `sessionID` and then opens the ping and the other `ConnectedClientService` streams.

> **Session header with the Node, Python and C# helpers.** These helpers send `hostMetadata` with every call but do not add the session ID to it. Make sure `hostMetadata` contains `SessionID` before the streams open: either return it from a `HostMetadata` getter that reads the current session ID, or call `connect(false)`, add the header, and then call `openConnectionsAfterConnect()` yourself (see the examples below). The gRPC-Web helper adds the header itself and offers `callMetadata()` for your own calls.

## 3. Reporting ready to work

Call `ConnectedClientService/ReportReadyToWork` with

```
UmbraClientReadyToWorkNotification { state: ReadyToWorkState { readyToWork: true, receiveAndDisplayMessages: false } }
```

If `response.ok` is false, `response.message` says why Umbra didn't accept it. Helper: `reportReadyToWork(state)`.

## 4. Keeping the session alive

Open the bidirectional `ConnectedClientService/Ping` stream with the session header and write a `PingPong` (with an increasing `requestCounter` and your `clientname`) every 5 seconds. When a `PingPong` arrives whose `clientname` isn't yours, set `responder` to your name and write it back.

An `error` or end of this stream means the connection is gone: reconnect (see [Reconnecting](#reconnecting)).

gRPC-Web cannot do bidirectional streams; call the unary `ConnectedClientService/PingUnary` on the same interval instead.

The helpers open the ping stream in `connect()` and raise `connectionLost` / `ConnectionLost` / `connection_lost` when it fails for good.

## 5. Binding a user

Most domain services act in a user context, so bind one before using them. Call `LumosProtobufClient.UserClient/Bind` with the session header:

```
LumosProtobuf.User.UserContextRequest {
  requestId:    <unique id>
  username:     "DMXCDefault"
  passwordHash: hashPasswordDMXC("DMXC3")
}
```

`DMXCDefault` / `DMXC3` are the defaults of a new DMXC project. The password is never sent in plain text. Hash the UTF-8 bytes with SHA-256, hash the raw digest 36 more times (37 rounds in total), and send the final digest as base64:

```
h = sha256(utf8(password))
repeat 36 times: h = sha256(h)
passwordHash = base64(h)
```

None of the packages ships this function yet, so implement it in your program.

## 6. Calling domain services

Create a client per service on the same channel and pass the session header on every call. The domain services follow one pattern, here with [`MacroClient`](../proto/Client/MacroClient.proto):

1. **Initial load:** call the unary `Get…` RPC (`GetMacros(GetMultipleRequest)`) and fill a local cache keyed by `id`.
2. **Change stream:** open the server-streaming `Receive…Changes` RPC (`ReceiveMacroChanges(GetRequest)`). Apply each message by its `changeType` (`EChangeType.Added`, `Changed`, `Removed`).
3. **Commands:** send unary requests such as `SetMacroButtonState`, then check `ConfirmedResponse.ok` and `message`.

Rules for all calls:

- **Request IDs.** Most requests have a `requestId`. Any string that is unique per run works, e.g. `<runtimeid>-<counter>`.
- **Deadlines.** Give every unary call a deadline (the helpers use 3 s). Without one, a call to a hung server never returns. Don't set deadlines on long-lived streams (`Ping`, `Receive…Changes`), or they get cut off.
- **Message size.** Raise the channel's send and receive limits to `MAX_MESSAGE_SIZE`; the gRPC default of 4 MB is too small for some responses.
- **gRPC-Web.** Only unary and server-streaming calls work. Client and bidirectional streams such as `SendBroadcast`, `ProcessClientControls` or `DMXClient.GetDmxChanges` fail in a browser.

## 7. Disconnecting

1. Cancel your own streams (`Receive…Changes`) and stop the ping.
2. Call `ClientService/Logoff` with an `UmbraLogoffRequest` holding the same `ClientProgramInfo`.
3. Close the channel.

Logoff usually fails when the server is already gone; finish the teardown either way. The helpers' `disconnect()` does steps 1 and 2 for their own streams.

## Reconnecting

A single failure often fires several callbacks: a ping error followed by stream end, a failed call, and so on. A robust client:

- Tags each connection attempt with a generation counter and ignores callbacks from older generations.
- Runs only one reconnect at a time.
- Tears down the old connection (step 7), waits a moment (e.g. 2 s), then restarts discovery or reconnects.
- Ignores `CANCELLED` errors it causes itself while closing streams.
- Reuses the same `runtimeid`.

## Examples

Each example logs in, binds the default user and toggles a macro button. Replace the endpoint and Net ID with yours.

### C#

```csharp
using Grpc.Core;
using Grpc.Net.Client;
using LumosProtobuf;
using LumosProtobuf.ConnectionClient;
using LumosProtobuf.User;
using UmbraClient;

class Data : IConnectionClientData
{
    public string? SessionID { get; set; }

    public ChannelBase UmbraChannel { get; } = MakeChannel("192.168.1.10", NetConstants.UMBRA_LISTEN_PORT);

    public ChannelBase CreateChannel(string host, int port) => MakeChannel(host, port);

    private static GrpcChannel MakeChannel(string host, int port) =>
        GrpcChannel.ForAddress($"http://{host}:{port}", new GrpcChannelOptions
        {
            MaxSendMessageSize = NetConstants.MAX_MESSAGE_SIZE,
            MaxReceiveMessageSize = NetConstants.MAX_MESSAGE_SIZE,
        });

    // Read on every call, so the session ID is included once it is known.
    public Metadata HostMetadata => SessionID == null ? new Metadata() : new Metadata { { "SessionID", SessionID } };

    public ClientProgramInfo ClientProgramInfo { get; } = new()
    {
        ProgramInfo = new ProgramInfo { ProgramName = "My Tool", ProgramVersion = "1.0.0" },
        ClientInfo = new ClientInfo
        {
            Hostname = Environment.MachineName,
            Type = EClientType.ExternalTool,
            Clientname = "My Tool",
            Runtimeid = Guid.NewGuid().ToString(),
            Networkid = "MyNetId",
        },
    };

    public string Clientname => "My Tool";
    public string NetworkID => "MyNetId";
}

var data = new Data();
var umbra = new UmbraConnectionClient { DataProvider = data };

await umbra.connectAsync(openConnections: false);
data.SessionID = umbra.SessionID;
umbra.OpenConnectionsAfterConnect(CancellationToken.None);
umbra.ConnectionLost += (_, _) => Console.WriteLine("connection lost");

await umbra.ReportReadyToWorkAsync(new ReadyToWorkState { ReadyToWork = true });

var users = new UserClient.UserClientClient(data.UmbraChannel);
await users.BindAsync(new UserContextRequest
{
    RequestId = Guid.NewGuid().ToString(),
    Username = "DMXCDefault",
    PasswordHash = HashPasswordDMXC("DMXC3"),
}, data.HostMetadata, deadline: DateTime.UtcNow.AddSeconds(3));

var macros = new MacroClient.MacroClientClient(data.UmbraChannel);
var list = await macros.GetMacrosAsync(new GetMultipleRequest { RequestId = Guid.NewGuid().ToString() },
    data.HostMetadata, deadline: DateTime.UtcNow.AddSeconds(3));
// ... SetMacroButtonStateAsync(...)

umbra.Disconnect();

static string HashPasswordDMXC(string password)
{
    var h = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(password));
    for (int i = 0; i < 36; i++)
        h = System.Security.Cryptography.SHA256.HashData(h);
    return Convert.ToBase64String(h);
}
```

### Node.js (TypeScript)

```ts
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { credentials, Metadata } from "@grpc/grpc-js";
import {
  createUmbraChannel, getLocalIPv4Addresses, LumosProtobuf, LumosProtobufClient, UmbraConnectionClient,
} from "@dmxcontrolprojects/dmxcontrol3-network-interface";

const host = "192.168.1.10";
const channel = createUmbraChannel(host);
const hostMetadata = new Metadata();

const umbra = new UmbraConnectionClient({
  umbraChannel: channel,
  createChannel: (h, p) => createUmbraChannel(h, p),
  hostMetadata,
  clientProgramInfo: LumosProtobuf.ClientProgramInfo.fromPartial({
    programInfo: { programName: "My Tool", programVersion: "1.0.0" },
    clientInfo: {
      hostname: hostname(),
      ips: getLocalIPv4Addresses(),
      type: LumosProtobuf.EClientType.ExternalTool,
      clientname: "My Tool",
      runtimeid: randomUUID(),
      networkid: "MyNetId",
    },
  }),
  clientname: "My Tool",
  networkID: "MyNetId",
});

await umbra.connect(false);
hostMetadata.set("SessionID", umbra.sessionID!);
umbra.openConnectionsAfterConnect();
umbra.on("connectionLost", () => console.log("connection lost"));

await umbra.reportReadyToWork({ readyToWork: true, receiveAndDisplayMessages: false });

// Service clients share the Umbra channel through `channelOverride`.
const deadline = () => ({ deadline: Date.now() + 3000 });
const opts = { channelOverride: channel };
const users = new LumosProtobufClient.UserClientClient(`${host}:17475`, credentials.createInsecure(), opts);
const macros = new LumosProtobufClient.MacroClientClient(`${host}:17475`, credentials.createInsecure(), opts);

users.bind(
  { requestId: randomUUID(), username: "DMXCDefault", passwordHash: hashPasswordDMXC("DMXC3") },
  hostMetadata, deadline(), (err, res) => {
    if (err) throw err;
    macros.getMacros({ requestId: randomUUID(), idFilter: [], userContextId: "" }, hostMetadata, deadline(), (err, list) => {
      // ... setMacroButtonState(...)
    });
  },
);

const changes = macros.receiveMacroChanges(LumosProtobuf.GetRequest.fromPartial({ requestId: randomUUID() }), hostMetadata); // no deadline on streams
changes.on("data", (m: LumosProtobuf.Macro.MacroChangedMessage) => { /* m.changeType, m.macroId */ });

function hashPasswordDMXC(password: string): string {
  let h = createHash("sha256").update(password, "utf8").digest();
  for (let i = 0; i < 36; i++) h = createHash("sha256").update(h).digest();
  return h.toString("base64");
}

// on shutdown
changes.cancel();
await umbra.disconnect();
channel.close();
```

### Python

```python
import asyncio, base64, hashlib, socket, uuid

from dmxc_protobuf.connection import UmbraConnectionClient, create_umbra_channel
from dmxc_protobuf.udp import get_local_ipv4_addresses
from dmxc_protobuf.Common.Types.UmbraServiceTypes_pb2 import (
    ClientInfo, ClientProgramInfo, EClientType, ProgramInfo, ReadyToWorkState,
)
from dmxc_protobuf.Common.Types.CommonTypes_pb2 import GetMultipleRequest, GetRequest
from dmxc_protobuf.Common.Types.User.UserServiceTypes_pb2 import UserContextRequest
from dmxc_protobuf.Client import MacroClient_pb2_grpc, UserClient_pb2_grpc


def hash_password_dmxc(password: str) -> str:
    h = hashlib.sha256(password.encode("utf-8")).digest()
    for _ in range(36):
        h = hashlib.sha256(h).digest()
    return base64.b64encode(h).decode("ascii")


class Data:
    def __init__(self, host: str):
        self.umbra_channel = create_umbra_channel(host)
        self.host_metadata: list[tuple[str, str]] = []
        self.client_program_info = ClientProgramInfo(
            programInfo=ProgramInfo(programName="My Tool", programVersion="1.0.0"),
            clientInfo=ClientInfo(
                hostname=socket.gethostname(),
                ips=get_local_ipv4_addresses(),
                type=EClientType.ExternalTool,
                clientname="My Tool",
                runtimeid=str(uuid.uuid4()),
                networkid="MyNetId",
            ),
        )
        self.clientname = "My Tool"
        self.network_id = "MyNetId"

    def create_channel(self, host, port):
        return create_umbra_channel(host, port)


async def main():
    data = Data("192.168.1.10")
    umbra = UmbraConnectionClient(data)
    umbra.connection_lost += lambda: print("connection lost")

    await umbra.connect(open_connections=False)
    data.host_metadata.append(("sessionid", umbra.session_id))
    umbra.open_connections_after_connect()

    await umbra.report_ready_to_work(ReadyToWorkState(readyToWork=True))

    md = data.host_metadata
    users = UserClient_pb2_grpc.UserClientStub(data.umbra_channel)
    await users.Bind(UserContextRequest(requestId=str(uuid.uuid4()), username="DMXCDefault",
                                        passwordHash=hash_password_dmxc("DMXC3")), metadata=md, timeout=3)

    macros = MacroClient_pb2_grpc.MacroClientStub(data.umbra_channel)
    result = await macros.GetMacros(GetMultipleRequest(requestId=str(uuid.uuid4())), metadata=md, timeout=3)

    async def watch():
        async for change in macros.ReceiveMacroChanges(GetRequest(requestId=str(uuid.uuid4())), metadata=md):
            print(change.changeType, change.macroId)

    watcher = asyncio.create_task(watch())
    # ... SetMacroButtonState(...)

    watcher.cancel()
    await umbra.disconnect()
    await data.umbra_channel.close()


asyncio.run(main())
```

### Browser (gRPC-Web)

See [`npm-web/README.md`](../npm-web/README.md) for the TLS and CORS caveats. The connection client adds the session header itself; pass `client.callMetadata()` to your own service clients:

```ts
import {
  createClient, createUmbraChannel, LumosProtobuf, LumosProtobufClient, Metadata, NetConstants, UmbraConnectionClient,
} from "@dmxcontrolprojects/dmxcontrol3-network-interface-web";

const channel = createUmbraChannel("umbra.tld", NetConstants.UMBRA_LISTEN_PORT_SECURE, true);
const umbra = new UmbraConnectionClient({
  umbraChannel: channel,
  hostMetadata: new Metadata(),
  clientProgramInfo: LumosProtobuf.ClientProgramInfo.fromPartial({
    clientInfo: { clientname: "My Web Tool", hostname: location.hostname, runtimeid: crypto.randomUUID(),
                  type: LumosProtobuf.EClientType.ExternalTool, networkid: "MyNetId" },
  }),
  clientname: "My Web Tool",
});

await umbra.connect();
await umbra.reportReadyToWork({ readyToWork: true, receiveAndDisplayMessages: false });

const opts = { "*": { metadata: umbra.callMetadata() } };
const users = createClient(LumosProtobufClient.UserClientDefinition, channel, opts);
await users.bind({ requestId: crypto.randomUUID(), username: "DMXCDefault", passwordHash: await hashPasswordDMXC("DMXC3") });

const macros = createClient(LumosProtobufClient.MacroClientDefinition, channel, opts);
const list = await macros.getMacros({ requestId: crypto.randomUUID() });
for await (const change of macros.receiveMacroChanges({ requestId: crypto.randomUUID() })) {
  // change.changeType, change.macroId
}

async function hashPasswordDMXC(password: string): Promise<string> {
  let h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
  for (let i = 0; i < 36; i++) h = new Uint8Array(await crypto.subtle.digest("SHA-256", h));
  return btoa(String.fromCharCode(...h));
}
```

## RPC reference

| Step | RPC | Kind | Session header |
| --- | --- | --- | --- |
| Visibility | `/LumosProtobufCommon.DMXCNetService/InformClientExists` | unary | no |
| Login | `/LumosProtobufCommon.ClientService/Login` | unary | no |
| Ready | `/LumosProtobufCommon.ConnectedClientService/ReportReadyToWork` | unary | yes |
| Keepalive | `/LumosProtobufCommon.ConnectedClientService/Ping` | bidi stream | yes |
| Keepalive (gRPC-Web) | `/LumosProtobufCommon.ConnectedClientService/PingUnary` | unary | yes |
| Client changes | `/LumosProtobufCommon.ConnectedClientService/ReceiveClientChanges` | server stream | yes |
| User | `/LumosProtobufClient.UserClient/Bind` | unary | yes |
| Domain | `/LumosProtobufClient.<Service>/…` | unary + server streams | yes |
| Logoff | `/LumosProtobufCommon.ClientService/Logoff` | unary | not needed (the helpers send it) |
