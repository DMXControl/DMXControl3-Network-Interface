"""Tests UmbraConnectionClient against an in-process fake Umbra server."""

import asyncio
import unittest
from dataclasses import dataclass
from typing import Optional

import grpc
import grpc.aio

from dmxc_protobuf.Common import UmbraClientService_pb2_grpc as svc
from dmxc_protobuf.Common.Types.BroadcastServiceTypes_pb2 import BroadcastMessage
from dmxc_protobuf.Common.Types.CommonTypes_pb2 import ConfirmedResponse
from dmxc_protobuf.Common.Types.UmbraServiceTypes_pb2 import (
    ClientControlRequest,
    ClientInfo,
    ClientProgramInfo,
    ClientLogoff,
    InformClientExistsResponse,
    PingPong,
    SetNetworkPropertyRequest,
    UmbraClientInfoMessage,
    UmbraClientProgramInfoResponse,
    UmbraLoginResponse,
    UmbraLogoffResponse,
    UmbraNetworkInfoResponse,
    UmbraUdpBroadcast,
)
from dmxc_protobuf.connection import (
    ClientEventArgs,
    EAutoconnectResult,
    LoginException,
    UmbraConnectionClient,
    create_umbra_channel,
)
from dmxc_protobuf.extensions import translateable_to_formatted_string
from dmxc_protobuf.udp import UmbraDiscoveryBroadcastEventArgs

UMBRA_INFO = ClientProgramInfo(clientInfo=ClientInfo(clientname="Umbra", runtimeid="umbra-1", networkid="net", ips=["127.0.0.1"]))


class FakeUmbra(svc.ClientServiceServicer, svc.ConnectedClientServiceServicer, svc.DMXCNetServiceServicer):
    def __init__(self) -> None:
        self.login_code = UmbraLoginResponse.NoError
        self.pongs: asyncio.Queue = asyncio.Queue()
        self.broadcasts_in: asyncio.Queue = asyncio.Queue()
        self.broadcasts_out: asyncio.Queue = asyncio.Queue()
        self.control_requests: asyncio.Queue = asyncio.Queue()
        self.control_responses: asyncio.Queue = asyncio.Queue()
        self.client_changes: asyncio.Queue = asyncio.Queue()
        self.logged_off = asyncio.Event()
        self.metadata_seen: list = []

    async def Login(self, request, context):
        self.metadata_seen.append(dict(context.invocation_metadata()))
        if self.login_code == -1:
            await context.abort(grpc.StatusCode.PERMISSION_DENIED, "nope")
        return UmbraLoginResponse(returnCode=self.login_code, sessionId="sess-1", umbraServer=UMBRA_INFO, message="msg")

    async def Logoff(self, request, context):
        self.logged_off.set()
        return UmbraLogoffResponse(bye="bye")

    async def Ping(self, request_iterator, context):
        # server initiated ping, which the client must answer
        yield PingPong(requestCounter=99, clientname="Umbra")
        async for p in request_iterator:
            await self.pongs.put(p)

    async def SendBroadcast(self, request_iterator, context):
        async def reader():
            async for m in request_iterator:
                await self.broadcasts_in.put(m)

        t = asyncio.ensure_future(reader())
        try:
            while True:
                yield await self.broadcasts_out.get()
        finally:
            t.cancel()

    async def ProcessClientControls(self, request_iterator, context):
        async def reader():
            async for r in request_iterator:
                await self.control_responses.put(r)

        t = asyncio.ensure_future(reader())
        try:
            while True:
                yield await self.control_requests.get()
        finally:
            t.cancel()

    async def ReceiveClientChanges(self, request, context):
        while True:
            yield await self.client_changes.get()

    async def ControlClient(self, request, context):
        return ConfirmedResponse(ok=True, requestId=request.source.runtimeid)

    async def GetClientProgramInfo(self, request, context):
        return UmbraClientProgramInfoResponse(info=ClientProgramInfo(clientInfo=ClientInfo(runtimeid=request.requestId)))

    async def ReportReadyToWork(self, request, context):
        return ConfirmedResponse(ok=True)

    async def GetUmbraNetworkInfo(self, request, context):
        return UmbraNetworkInfoResponse(connectedClients=[UMBRA_INFO])

    async def InformClientExists(self, request, context):
        return InformClientExistsResponse(
            ok=True, umbra=UMBRA_INFO, requests=[SetNetworkPropertyRequest(targetClientName="renamed")]
        )


@dataclass
class Data:
    umbra_channel: grpc.aio.Channel
    port: int
    client_program_info: ClientProgramInfo
    clientname: str = "Tester"
    network_id: str = "net"
    host_metadata: Optional[list] = None

    def create_channel(self, host: str, port: int) -> grpc.aio.Channel:
        return create_umbra_channel(host, self.port)


async def wait_for(q: asyncio.Queue, timeout: float = 5.0):
    return await asyncio.wait_for(q.get(), timeout)


class ConnectionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.umbra = FakeUmbra()
        self.server = grpc.aio.server()
        svc.add_ClientServiceServicer_to_server(self.umbra, self.server)
        svc.add_ConnectedClientServiceServicer_to_server(self.umbra, self.server)
        svc.add_DMXCNetServiceServicer_to_server(self.umbra, self.server)
        self.port = self.server.add_insecure_port("127.0.0.1:0")
        await self.server.start()

        self.channel = create_umbra_channel("127.0.0.1", self.port)
        info = ClientProgramInfo(clientInfo=ClientInfo(clientname="Tester", runtimeid="me", networkid="net"))
        self.data = Data(self.channel, self.port, info, host_metadata=[("x-test", "1")])
        self.client = UmbraConnectionClient(self.data)

    async def asyncTearDown(self) -> None:
        await self.client.disconnect()
        await self.channel.close()
        await self.server.stop(0)

    async def test_login_and_streams(self):
        resp = await self.client.connect()
        self.assertEqual(resp.sessionId, "sess-1")
        self.assertEqual(self.client.session_id, "sess-1")
        self.assertEqual(self.client.connected_to_umbra.clientInfo.runtimeid, "umbra-1")
        self.assertEqual(self.umbra.metadata_seen[0].get("x-test"), "1")

        # ping: own ping and the answer to Umbra's ping
        got = [await wait_for(self.umbra.pongs), await wait_for(self.umbra.pongs)]
        self.assertIn(PingPong(requestCounter=1, clientname="Tester"), got)
        self.assertIn(PingPong(requestCounter=99, clientname="Umbra", responder="Tester"), got)

        # broadcast both directions
        received: asyncio.Queue = asyncio.Queue()
        self.client.broadcast_received += lambda a: received.put_nowait(a.message)
        self.assertTrue(self.client.send_broadcast(BroadcastMessage()))
        await wait_for(self.umbra.broadcasts_in)
        await self.umbra.broadcasts_out.put(BroadcastMessage())
        await wait_for(received)

        # client control, async handler
        async def handler(args):
            args.processed = True
            args.ok = True
            args.message = "done {0}"

        self.client.client_control_request_received += handler
        await self.umbra.control_requests.put(ClientControlRequest(requestId="r1"))
        r = await wait_for(self.umbra.control_responses)
        self.assertEqual((r.requestId, r.ok, r.message.formatString), ("r1", True, "done {0}"))

        # user changes
        changes: asyncio.Queue = asyncio.Queue()
        self.client.umbra_user_changed += changes.put_nowait
        await self.umbra.client_changes.put(UmbraClientInfoMessage(client=UMBRA_INFO, logoff=ClientLogoff))
        ev: ClientEventArgs = await wait_for(changes)
        self.assertTrue(ev.logoff)
        self.assertFalse(ev.login)

        # unary helpers
        users = await self.client.get_umbra_users()
        self.assertEqual([u.runtimeid for u in users], ["umbra-1"])
        info = await self.client.get_client_program_info("abc")
        self.assertEqual(info.clientInfo.runtimeid, "abc")
        r = await self.client.send_client_control_request(ClientControlRequest(controlClientRuntimeId="other"))
        self.assertEqual(r.requestId, "me")
        with self.assertRaises(ValueError):
            await self.client.send_client_control_request(ClientControlRequest(controlClientRuntimeId="me"))

        await self.client.disconnect()
        await asyncio.wait_for(self.umbra.logged_off.wait(), 5)
        self.assertIsNone(self.client.session_id)
        self.assertFalse(self.client.send_broadcast(BroadcastMessage()))

    async def test_control_timeout_and_unprocessed(self):
        await self.client.connect()
        await self.umbra.control_requests.put(ClientControlRequest(requestId="r1"))
        r = await wait_for(self.umbra.control_responses)
        self.assertEqual((r.ok, translateable_to_formatted_string(r.message)), (False, "Not processed"))

        async def slow(args):
            await asyncio.sleep(2)

        self.client.client_control_request_received += slow
        await self.umbra.control_requests.put(ClientControlRequest(requestId="r2"))
        r = await wait_for(self.umbra.control_responses)
        self.assertEqual((r.ok, r.message.formatString), (False, "Timeout"))

    async def test_login_failures(self):
        self.umbra.login_code = UmbraLoginResponse.ClientLimitReached
        with self.assertRaises(LoginException) as cm:
            await self.client.connect()
        self.assertEqual(cm.exception.return_code, UmbraLoginResponse.ClientLimitReached)

        self.umbra.login_code = -1
        with self.assertRaises(LoginException) as cm:
            await self.client.connect()
        self.assertEqual(cm.exception.return_code, UmbraLoginResponse.AccessDenied)
        self.assertIsNone(self.client.session_id)

    async def test_connection_lost(self):
        lost = asyncio.Event()
        self.client.connection_lost += lost.set
        await self.client.connect()
        await wait_for(self.umbra.pongs)
        await self.server.stop(0)
        await asyncio.wait_for(lost.wait(), 10)

    async def test_discovery_autoconnect(self):
        requests = []
        targets = []

        async def autoconnect(host, port):
            targets.append((host, port))
            await self.client.connect()
            return EAutoconnectResult.OK

        umbra = ClientProgramInfo()
        umbra.CopyFrom(UMBRA_INFO)
        umbra.clientInfo.umbraPort = self.port
        args = UmbraDiscoveryBroadcastEventArgs(UmbraUdpBroadcast(umbraServer=umbra), ("127.0.0.1", 17474))
        await self.client.process_discovery_broadcast(args, requests.extend, autoconnect, ["127.0.0.1"])

        self.assertEqual([r.targetClientName for r in requests], ["renamed"])
        self.assertEqual(targets, [("127.0.0.1", self.port)])
        self.assertEqual(self.client.session_id, "sess-1")


if __name__ == "__main__":
    unittest.main()
