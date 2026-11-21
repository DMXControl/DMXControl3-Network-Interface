# @dmxcontrolprojects/dmxcontrol3-network-interface-web

Generated [gRPC-Web](https://github.com/grpc/grpc-web) client library for DMXControl 3, for browsers (it also works in Node, Deno and Bun, since it only needs `fetch`). For Node applications that can use plain gRPC, use [`@dmxcontrolprojects/dmxcontrol3-network-interface`](https://www.npmjs.com/package/@dmxcontrolprojects/dmxcontrol3-network-interface) instead.

The messages are generated with [ts-proto](https://github.com/stephenh/ts-proto) using the same options as the Node package, so message types and helpers are identical (except that `bytes` fields are `Uint8Array` instead of `Buffer`). The services are generated as [nice-grpc-web](https://github.com/deeplay-io/nice-grpc/tree/master/packages/nice-grpc-web) definitions (`...ServiceDefinition`).

The package ships as ES modules with `"sideEffects": false`, so bundlers only include the messages and services you use.

The generated code is exported per protobuf package (`LumosProtobuf`, `LumosProtobufClient`, `LumosProtobufCommon`, `LumosProtobufServer`, ...), also as subpaths such as `@dmxcontrolprojects/dmxcontrol3-network-interface-web/LumosProtobuf`.

## Connecting to Umbra

Umbra accepts gRPC-Web on its **secure port 17476** (`NetConstants.UMBRA_LISTEN_PORT_SECURE`), which is HTTP/2 over TLS:

```ts
const channel = createUmbraChannel(host, NetConstants.UMBRA_LISTEN_PORT_SECURE, true); // https://host:17476
```

- The plain port 17475 only speaks HTTP/2 without TLS (h2c), which browsers do not support.
- Umbra uses a self-signed certificate (`CN=umbra.tld`). Browsers reject it until it is trusted, and the name only matches if Umbra is reached as `umbra.tld`.
- After the login, Umbra expects the session ID in the `sessionid` header (`SESSION_ID_HEADER`) on every call. `UmbraConnectionClient` adds it automatically. For your own calls, pass `{ metadata: connection.callMetadata() }`.
- Umbra allows CORS from any origin but does not expose the `grpc-status` / `grpc-message` headers. Errors are sent in exactly these headers (trailers-only responses), so in a browser app on another origin a failed call shows up as `UNKNOWN` ("Response stream closed without gRPC status") instead of its real code. Successful calls are not affected.
- Node (for tests or tools) needs an HTTP/2 capable `fetch`, e.g. `setGlobalDispatcher(new Agent({ allowH2: true }))` from `undici`, see `test/live/umbra.live.js`.

## Limitations

gRPC-Web supports unary and server streaming calls only. Client streaming and bidirectional streaming methods are generated (the types are the same for all clients), but calling them from a browser fails. This affects:

- `ConnectedClientService.Ping`: use `PingUnary` (`UmbraConnectionClient` does this).
- `ConnectedClientService.SendBroadcast` and `ProcessClientControls`: not available, so this package's `UmbraConnectionClient` has no broadcasts and does not answer client control requests.
- Other streaming methods such as `DMXClient.GetDmxChanges` and `CuelistClient.ReceiveCuelistProgressChanges`.

Browsers cannot send or receive UDP either, so there is no `UmbraDiscoveryClient`. Connect to a known host instead.

## Helpers

Exported from the package root:

- `UmbraConnectionClient`: login/logoff, the mandatory ping (via `PingUnary`), client change events and the unary helpers (`getUmbraUsers`, `getClientProgramInfo`, `sendClientControlRequest`, `reportReadyToWork`). `callMetadata()` returns the host metadata plus the session ID. Also `IConnectionClientData`, `createUmbraChannel`, `SESSION_ID_HEADER` and `LoginException`.
- `NetConstants`, `translatable` / `_`, `translateableToFormattedString` and the message helpers (`objectDataToObjectSimple`, `projectVersionIdFromString`, `compareProjectVersionIds`, `colorIsWhite`, `containsNonAsciiCharacters`, ...). They are the same code as in the Node package.
- Re-exports from nice-grpc-web: `createClient`, `createChannel`, `FetchTransport`, `Metadata`, `Status`, `ClientError`.

```ts
import { createClient, createUmbraChannel, LumosProtobuf, LumosProtobufServer, Metadata, NetConstants, UmbraConnectionClient } from "@dmxcontrolprojects/dmxcontrol3-network-interface-web";

const channel = createUmbraChannel("192.168.1.10", NetConstants.UMBRA_LISTEN_PORT_SECURE, true); // https://192.168.1.10:17476
const client = new UmbraConnectionClient({
  umbraChannel: channel,
  hostMetadata: new Metadata(), // sent with every call
  // hostname, type and networkid are required, otherwise Umbra answers InvalidLoginData
  clientProgramInfo: LumosProtobuf.ClientProgramInfo.fromPartial({
    clientInfo: { clientname: "My Web Tool", hostname: location.hostname, runtimeid: crypto.randomUUID(), type: LumosProtobuf.EClientType.ExternalTool, networkid: "" },
  }),
  clientname: "My Web Tool",
});

client.on("umbraUserChanged", (e) => console.log(e.client.clientname, e.login ? "joined" : "left"));
client.on("connectionLost", () => console.log("lost"));

await client.connect();
await client.reportReadyToWork({ readyToWork: true, receiveAndDisplayMessages: false });

// any other service: unary calls return promises, server streams are async iterables
const devices = createClient(LumosProtobufServer.DeviceServiceDefinition, channel, { "*": { metadata: client.callMetadata() } });
// ...

await client.disconnect();
```

Calls take an `AbortSignal` (`{ signal }`) for cancellation. Errors are `ClientError` instances with a `code` from `Status`.

## Tests

`npm test` runs against an in-process gRPC-Web server. `npm run test:live` runs against a real Umbra (`UMBRA_HOST`, default `127.0.0.1`, and `UMBRA_PORT`, default 17476); it logs in as an ExternalTool for about 12 s and logs off again.
