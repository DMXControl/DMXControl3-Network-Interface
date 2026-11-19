# dmxcontrol3-network-interface

Generated gRPC/protobuf client library for DMXControl 3, plus Python ports of the helpers from the C# `LumosProtobuf` library.

```sh
pip install dmxcontrol3-network-interface
```

The import package is `dmxc_protobuf`:

```python
import grpc
from dmxc_protobuf.Client import AudioClient_pb2_grpc

channel = grpc.insecure_channel("localhost:50051")
stub = AudioClient_pb2_grpc.AudioClientStub(channel)
```

## Helpers

| Module | Contents |
|---|---|
| `dmxc_protobuf.connection` | `UmbraConnectionClient` (login/logoff, mandatory ping, broadcasts, client control requests, client change events, discovery handling), `ConnectionClientData` protocol, `create_umbra_channel`, `LoginException` |
| `dmxc_protobuf.udp` | `UmbraDiscoveryClient` (multicast discovery of Umbra servers), `UdpListener`, `get_local_ipv4_addresses` |
| `dmxc_protobuf.net_constants` | Ports, the multicast address and message size limits |
| `dmxc_protobuf.i18n` | `translatable` / `_` to build `TranslateableData` |
| `dmxc_protobuf.extensions` | Helpers for generated messages: `translateable_to_formatted_string`, `object_data_to_object_simple`, `project_version_id_from_string`, `merge_todos`, `color_is_white`, ... |
| `dmxc_protobuf.tools` | `contains_non_ascii_characters` |

The connection client uses `grpc.aio`. Event handlers are added with `+=` and may be plain or async functions:

```python
import asyncio
from dmxc_protobuf.connection import UmbraConnectionClient, create_umbra_channel
from dmxc_protobuf.Common.Types.UmbraServiceTypes_pb2 import ClientInfo, ClientProgramInfo, ReadyToWorkState


class Data:
    def __init__(self):
        self.umbra_channel = create_umbra_channel("127.0.0.1")
        self.host_metadata = []  # metadata sent with every call
        self.client_program_info = ClientProgramInfo(clientInfo=ClientInfo(clientname="My Tool"))
        self.clientname = "My Tool"
        self.network_id = ""

    def create_channel(self, host, port):
        return create_umbra_channel(host, port)


async def main():
    client = UmbraConnectionClient(Data())
    client.broadcast_received += lambda args: print("broadcast", args.message)
    await client.connect()
    await client.report_ready_to_work(ReadyToWorkState(readyToWork=True))
    ...
    await client.disconnect()


asyncio.run(main())
```

`get_local_ipv4_addresses` lists every interface if the optional [`ifaddr`](https://pypi.org/project/ifaddr/) package is installed; without it, it falls back to the host name lookup and the default route.
