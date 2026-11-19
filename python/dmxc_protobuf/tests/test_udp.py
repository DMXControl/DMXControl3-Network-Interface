import asyncio
import socket
import unittest

from dmxc_protobuf import net_constants
from dmxc_protobuf.Common.Types.UmbraServiceTypes_pb2 import ClientInfo, ClientProgramInfo, UmbraUdpBroadcast
from dmxc_protobuf.udp import UmbraDiscoveryClient, get_local_ipv4_addresses


class DiscoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_receives_broadcast(self):
        client = UmbraDiscoveryClient()
        got: asyncio.Queue = asyncio.Queue()
        client.umbra_discovery_broadcast_received += got.put_nowait
        await client.start_discovery([])  # no multicast join; unicast datagrams still arrive
        try:
            bc = UmbraUdpBroadcast(umbraServer=ClientProgramInfo(clientInfo=ClientInfo(clientname="Umbra")))
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.sendto(b"\xff\xff garbage", ("127.0.0.1", net_constants.DMXCNET_MULTICAST_PORT))
                s.sendto(bc.SerializeToString(), ("127.0.0.1", net_constants.DMXCNET_MULTICAST_PORT))
            args = await asyncio.wait_for(got.get(), 5)
            self.assertEqual(args.broadcast.umbraServer.clientInfo.clientname, "Umbra")
            self.assertEqual(args.broadcast.sourceEndPoint, "127.0.0.1")
            self.assertEqual(len(client.get_broadcast_history(True, 0)), 1)
        finally:
            client.dispose()

    def test_local_addresses(self):
        self.assertIn("127.0.0.1", get_local_ipv4_addresses(include_loopback=True))
        self.assertTrue(all(not ip.startswith("127.") for ip in get_local_ipv4_addresses()))


if __name__ == "__main__":
    unittest.main()
