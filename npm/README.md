# @dmxcontrolprojects/dmxcontrol3-network-interface

Generated gRPC/protobuf client library for DMXControl 3 (via [ts-proto](https://github.com/stephenh/ts-proto) and `@grpc/grpc-js`), plus TypeScript ports of the helpers from the C# `LumosProtobuf` library.

The generated code is exported per protobuf package (`LumosProtobuf`, `LumosProtobufClient`, `LumosProtobufCommon`, `LumosProtobufServer`, ...), also as subpaths such as `@dmxcontrolprojects/dmxcontrol3-network-interface/LumosProtobuf`.

## Helpers

Exported from the package root:

- `UmbraConnectionClient`: login/logoff, the mandatory ping, broadcasts, client control requests, client change events and discovery handling. Also `IConnectionClientData`, `createUmbraChannel` and `LoginException`.
- `UmbraDiscoveryClient`: multicast discovery of Umbra servers. Also `UdpListener` and `getLocalIPv4Addresses`.
- `NetConstants`: ports, the multicast address and message size limits.
- `translatable` / `_`: build `TranslateableData`. `translateableToFormattedString` resolves it back to a string.
- Message helpers: `objectDataToObjectSimple`, `projectVersionIdFromString`, `compareProjectVersionIds`, `projectDataFindVersion`, `mergeToDos`, `dependencyObjectToTreeString`, `colorIsWhite`, `containsNonAsciiCharacters`, ...

```ts
import { Metadata } from "@grpc/grpc-js";
import { createUmbraChannel, LumosProtobuf, UmbraConnectionClient } from "@dmxcontrolprojects/dmxcontrol3-network-interface";

const client = new UmbraConnectionClient({
  umbraChannel: createUmbraChannel("127.0.0.1"),
  createChannel: (host, port) => createUmbraChannel(host, port),
  hostMetadata: new Metadata(), // sent with every call
  clientProgramInfo: LumosProtobuf.ClientProgramInfo.fromPartial({ clientInfo: { clientname: "My Tool" } }),
  clientname: "My Tool",
  networkID: "",
});

client.on("broadcastReceived", ({ message }) => console.log(message));
client.on("connectionLost", () => console.log("lost"));

await client.connect();
await client.reportReadyToWork({ readyToWork: true, receiveAndDisplayMessages: false });
// ...
await client.disconnect();
```

Listeners of `clientControlRequestReceived` may be async; set `processed`, `ok` and `message` on the event args within 500 ms.
