"""Connection to an Umbra server (port of the C# ``UmbraConnectionClient``).

Uses ``grpc.aio``; all network methods are coroutines.
"""

from __future__ import annotations

import asyncio
import enum
import inspect
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Optional, Protocol, Sequence, TypeVar

import grpc
import grpc.aio

from dmxc_protobuf import net_constants
from dmxc_protobuf.Common import UmbraClientService_pb2_grpc as svc
from dmxc_protobuf.Common.Types.BroadcastServiceTypes_pb2 import BroadcastMessage
from dmxc_protobuf.Common.Types.CommonTypes_pb2 import ConfirmedResponse, GetRequest
from dmxc_protobuf.Common.Types.UmbraServiceTypes_pb2 import (
    ClientControlRequest,
    ClientInfo,
    ClientProgramInfo,
    ELogoffReason_Unknown,
    InformClientExistsRequest,
    PingPong,
    ReadyToWorkState,
    SetNetworkPropertyRequest,
    UmbraClientReadyToWorkNotification,
    UmbraLoginRequest,
    UmbraLoginResponse,
    UmbraLogoffRequest,
)
from dmxc_protobuf.events import Event
from dmxc_protobuf.i18n import translatable as _t
from dmxc_protobuf.tools import contains_non_ascii_characters
from dmxc_protobuf.udp import UmbraDiscoveryBroadcastEventArgs

CALL_TIMEOUT = 3.0
PING_INTERVAL = 5.0
CLIENT_CONTROL_TIMEOUT = 0.5

Metadata = Sequence[tuple[str, str | bytes]]
T = TypeVar("T")


class ConnectionClientData(Protocol):
    """Supplies everything :class:`UmbraConnectionClient` needs. Plain attributes satisfy it."""

    #: Channel to the Umbra server the client is connected to.
    umbra_channel: grpc.aio.Channel
    #: Metadata sent with every call.
    host_metadata: Optional[Metadata]
    client_program_info: ClientProgramInfo
    clientname: str
    network_id: str

    def create_channel(self, host: str, port: int) -> grpc.aio.Channel:
        """Creates a channel to another (potential) Umbra server, used during discovery."""
        ...


def create_umbra_channel(
    host: str,
    port: int = net_constants.UMBRA_LISTEN_PORT,
    credentials: Optional[grpc.ChannelCredentials] = None,
) -> grpc.aio.Channel:
    """Creates an aio channel to an Umbra server with DMXControl's maximum message size."""
    target = f"{host}:{port}"
    options = [
        ("grpc.max_send_message_length", net_constants.MAX_MESSAGE_SIZE),
        ("grpc.max_receive_message_length", net_constants.MAX_MESSAGE_SIZE),
    ]
    if credentials is None:
        return grpc.aio.insecure_channel(target, options=options)
    return grpc.aio.secure_channel(target, credentials, options=options)


class LoginException(Exception):
    def __init__(self, message: str, return_code: int, session_id: Optional[str]) -> None:
        super().__init__(message)
        #: an ``UmbraLoginResponse.EReturnCode`` value
        self.return_code = return_code
        self.session_id = session_id


@dataclass(frozen=True)
class ClientEventArgs:
    client: ClientInfo
    _login: Optional[bool] = None

    @property
    def login(self) -> bool:
        return self._login is True

    @property
    def logoff(self) -> bool:
        return self._login is False


@dataclass(frozen=True)
class BroadcastEventArgs:
    message: BroadcastMessage


@dataclass
class ClientControlEventArgs:
    """Set ``processed``, ``ok`` and ``message`` within 500 ms to answer the request."""

    request: ClientControlRequest
    processed: bool = False
    ok: bool = False
    message: Optional[str] = field(default=None)


class EAutoconnectResult(enum.Enum):
    OK = 0
    Error = 1
    NotReady = 2


def _code(e: BaseException) -> Optional[grpc.StatusCode]:
    return e.code() if isinstance(e, grpc.RpcError) else None  # type: ignore[attr-defined]


class UmbraConnectionClient:
    """Logs in to Umbra, keeps the mandatory ping alive, and handles broadcasts, client
    control requests and client change notifications.

    Events (subscribe with ``+=``; handlers may be sync or async):
    ``umbra_user_changed(ClientEventArgs)``, ``broadcast_received(BroadcastEventArgs)``,
    ``client_control_request_received(ClientControlEventArgs)``, ``connection_lost()``.
    """

    def __init__(self, data_provider: Optional[ConnectionClientData] = None, logger: Optional[logging.Logger] = None) -> None:
        self.data_provider: ConnectionClientData = data_provider  # type: ignore[assignment]
        self.logger = logger or logging.getLogger(__name__)

        self.umbra_user_changed: Event[[ClientEventArgs]] = Event()
        self.broadcast_received: Event[[BroadcastEventArgs]] = Event()
        self.client_control_request_received: Event[[ClientControlEventArgs]] = Event()
        self.connection_lost: Event[[]] = Event()

        self.session_id: Optional[str] = None
        self.connected_to_umbra: Optional[ClientProgramInfo] = None

        self._tasks: set[asyncio.Task[Any]] = set()
        self._generation = 0
        self._broadcast_queue: Optional[asyncio.Queue[BroadcastMessage]] = None
        self._auto_connection_in_progress = False

    # ~~~~~~~~~~~~~~~~~~~ helpers ~~~~~~~~~~~~~~~~~~~

    @property
    def _md(self) -> Optional[Metadata]:
        return self.data_provider.host_metadata

    def _connected_stub(self) -> svc.ConnectedClientServiceStub:
        return svc.ConnectedClientServiceStub(self.data_provider.umbra_channel)

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _active(self, generation: int) -> bool:
        return generation == self._generation

    # ~~~~~~~~~~~~~~~~~~~ public API ~~~~~~~~~~~~~~~~~~~

    async def connect(self, open_connections: bool = True) -> UmbraLoginResponse:
        """Logs in to Umbra. Raises :class:`LoginException` if the login fails."""
        stub = svc.ClientServiceStub(self.data_provider.umbra_channel)
        request = UmbraLoginRequest(client=self.data_provider.client_program_info)
        start = time.monotonic()
        try:
            response: UmbraLoginResponse = await stub.Login(request, metadata=self._md, timeout=CALL_TIMEOUT)
        except grpc.RpcError as e:
            code = (
                UmbraLoginResponse.AccessDenied
                if _code(e) == grpc.StatusCode.PERMISSION_DENIED
                else UmbraLoginResponse.Error
            )
            raise LoginException(e.details() or str(e), code, None) from e  # type: ignore[attr-defined]
        finally:
            self.logger.debug("Login Call: %d ms", (time.monotonic() - start) * 1000)

        if contains_non_ascii_characters(response.sessionId, True):
            raise LoginException("Invalid SessionID", UmbraLoginResponse.Error, response.sessionId)

        if response.returnCode not in (UmbraLoginResponse.NoError, UmbraLoginResponse.AlreadyLoggedIn):
            raise LoginException(response.message, response.returnCode, response.sessionId)

        self.session_id = response.sessionId
        self.connected_to_umbra = response.umbraServer if response.HasField("umbraServer") else None

        if open_connections:
            self.open_connections_after_connect()

        return response

    async def report_ready_to_work(self, state: ReadyToWorkState) -> None:
        request = UmbraClientReadyToWorkNotification(state=state)
        try:
            await self._connected_stub().ReportReadyToWork(request, metadata=self._md, timeout=CALL_TIMEOUT)
        except Exception as e:
            self.logger.debug("report_ready_to_work: %s", e, exc_info=True)

    async def send_client_control_request(self, request: ClientControlRequest) -> Optional[ConfirmedResponse]:
        """Asks Umbra to forward a control request to another client. Returns None on failure."""
        if request is None or not request.controlClientRuntimeId:
            return None

        cinfo = self.data_provider.client_program_info.clientInfo
        if request.controlClientRuntimeId == cinfo.runtimeid:
            raise ValueError("Cannot send a client control request to yourself")

        request.source.CopyFrom(cinfo)
        try:
            return await self._connected_stub().ControlClient(request, metadata=self._md, timeout=CALL_TIMEOUT)
        except Exception as e:
            self.logger.debug("send_client_control_request: %s", e, exc_info=True)
            return None

    async def disconnect(self) -> None:
        """Logs off from Umbra and closes all streams."""
        if self.session_id is not None:
            stub = svc.ClientServiceStub(self.data_provider.umbra_channel)
            request = UmbraLogoffRequest(client=self.data_provider.client_program_info)
            try:
                response = await stub.Logoff(request, metadata=self._md, timeout=CALL_TIMEOUT)
                self.logger.info("Disconnected from Umbra Server: %s", response.bye)
            except Exception as e:
                self.logger.debug("Unable to logoff: %s", e, exc_info=True)

        self.session_id = None
        self.connected_to_umbra = None
        await self._close_streams()

    async def _close_streams(self) -> None:
        self._generation += 1
        self._broadcast_queue = None
        tasks = list(self._tasks)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def send_broadcast(self, m: BroadcastMessage) -> bool:
        """Queues a broadcast for all clients. Returns False if the broadcast stream is not open."""
        if m is None or self._broadcast_queue is None:
            return False
        self._broadcast_queue.put_nowait(m)
        return True

    def open_connections_after_connect(self) -> None:
        """Opens the ping, client change, broadcast and client control streams.
        Must be called from a running event loop."""
        self._generation += 1
        for t in list(self._tasks):
            t.cancel()
        gen = self._generation

        start = time.monotonic()
        self._spawn(self._run_ping(gen))
        self._spawn(self._run_receive_user_changes(gen))
        self._broadcast_queue = asyncio.Queue()
        self._spawn(self._run_broadcast(gen, self._broadcast_queue))
        self._spawn(self._run_control_client(gen))
        self.logger.debug("OpenConnectionsAfterConnect: %d ms", (time.monotonic() - start) * 1000)

    async def get_umbra_users(self) -> list[ClientInfo]:
        """The clients currently connected to Umbra (empty on failure)."""
        stub = svc.DMXCNetServiceStub(self.data_provider.umbra_channel)
        try:
            res = await stub.GetUmbraNetworkInfo(GetRequest(), metadata=self._md, timeout=CALL_TIMEOUT)
            return [c.clientInfo for c in res.connectedClients]
        except Exception as e:
            self.logger.error("%s", e, exc_info=True)
            return []

    async def get_client_program_info(self, runtime_id: str) -> Optional[ClientProgramInfo]:
        try:
            x = await self._connected_stub().GetClientProgramInfo(
                GetRequest(requestId=runtime_id), metadata=self._md, timeout=CALL_TIMEOUT
            )
            return x.info if x.HasField("info") else None
        except Exception:
            return None

    # ~~~~~~~~~~~~~~~~~~~ streams ~~~~~~~~~~~~~~~~~~~

    def _handle_stream_end(self, name: str, gen: int, error: Optional[BaseException], restart: Callable[[], None]) -> None:
        """Ignored when closed or unavailable, restarted on UNKNOWN / CANCELLED, logged otherwise."""
        if not self._active(gen) or error is None:
            return
        code = _code(error)
        if code == grpc.StatusCode.UNAVAILABLE:
            return
        if code in (grpc.StatusCode.UNKNOWN, grpc.StatusCode.CANCELLED):
            self.logger.debug("Unknown RpcError. Restarting %s.", name)
            restart()
            return
        self.logger.error("%s failed: %s", name, error, exc_info=error)

    async def _run_receive_user_changes(self, gen: int) -> None:
        call = self._connected_stub().ReceiveClientChanges(GetRequest(), metadata=self._md)
        error: Optional[BaseException] = None
        try:
            async for resp in call:
                login: Optional[bool] = None
                reason = resp.WhichOneof("reason")
                if reason == "login":
                    if not resp.login:
                        self.logger.debug("Strange User Info call. Reason is Login, but Login is false???. Ignoring.")
                        continue
                    login = True
                elif reason == "logoff":
                    if resp.logoff == ELogoffReason_Unknown:
                        self.logger.debug("Strange User Info call. Reason is Logoff, but value is unknown???. Ignoring.")
                        continue
                    login = False

                if not resp.HasField("client") or not resp.client.HasField("clientInfo"):
                    self.logger.debug("Strange User Info call. No User provided. Ignoring.")
                    continue

                self.umbra_user_changed.fire(ClientEventArgs(resp.client.clientInfo, login))
        except asyncio.CancelledError:
            call.cancel()
            raise
        except Exception as e:
            error = e
        self._handle_stream_end("ReceiveUserChanges", gen, error, lambda: self._spawn(self._run_receive_user_changes(gen)))

    async def _run_ping(self, gen: int, retry_on_disconnect: bool = False) -> None:
        call = self._connected_stub().Ping(metadata=self._md)
        lock = asyncio.Lock()
        name = self.data_provider.clientname

        async def sender() -> None:
            counter = 0
            try:
                while True:
                    counter += 1
                    async with lock:
                        await call.write(PingPong(requestCounter=counter, clientname=self.data_provider.clientname))
                    await asyncio.sleep(PING_INTERVAL)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # the reader sees the final status

        send_task = asyncio.ensure_future(sender())
        error: Optional[BaseException] = None
        try:
            async for pong in call:
                retry_on_disconnect = False  # a successful exchange: the next failure gets a retry again
                name = self.data_provider.clientname
                if pong.clientname != name:
                    pong.responder = name
                    async with lock:
                        await call.write(pong)
        except asyncio.CancelledError:
            send_task.cancel()
            call.cancel()
            raise
        except Exception as e:
            error = e
        finally:
            send_task.cancel()

        if not self._active(gen):
            return
        call.cancel()

        if retry_on_disconnect:
            self.logger.warning("Connection to Umbra lost.")
            self.connection_lost.fire()
            return

        code = _code(error) if error else grpc.StatusCode.OK
        if code in (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.UNAUTHENTICATED):
            self.logger.info("Ping unavailable, maybe connection to Umbra lost?")
        elif code in (grpc.StatusCode.UNKNOWN, grpc.StatusCode.CANCELLED, grpc.StatusCode.OK):
            self.logger.debug("Unknown RpcError. Restarting Ping.")
        else:
            self.logger.error("Ping failed: %s", error, exc_info=error)
        self._spawn(self._run_ping(gen, True))

    async def _run_broadcast(self, gen: int, queue: asyncio.Queue[BroadcastMessage]) -> None:
        call = self._connected_stub().SendBroadcast(metadata=self._md)

        async def sender() -> None:
            try:
                while True:
                    m = await queue.get()
                    await call.write(m)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # the reader sees the final status

        send_task = asyncio.ensure_future(sender())
        error: Optional[BaseException] = None
        try:
            async for bc in call:
                self.broadcast_received.fire(BroadcastEventArgs(bc))
        except asyncio.CancelledError:
            send_task.cancel()
            call.cancel()
            raise
        except Exception as e:
            error = e
        finally:
            send_task.cancel()

        restarted = False

        def restart() -> None:
            nonlocal restarted
            restarted = True
            # take over the messages that were not sent yet
            self._spawn(self._run_broadcast(gen, queue))

        self._handle_stream_end("Broadcast", gen, error, restart)
        if not restarted and self._active(gen) and self._broadcast_queue is queue:
            self._broadcast_queue = None

    async def _run_control_client(self, gen: int) -> None:
        call = self._connected_stub().ProcessClientControls(metadata=self._md)
        error: Optional[BaseException] = None
        try:
            async for req in call:
                args = ClientControlEventArgs(req)
                handler_task = asyncio.ensure_future(self.client_control_request_received.fire_async(args))
                done, _ = await asyncio.wait({handler_task}, timeout=CLIENT_CONTROL_TIMEOUT)
                timeout = not done

                if timeout:
                    message = _t("Timeout")
                elif args.processed:
                    message = _t(args.message or "")
                else:
                    message = _t("Not processed")
                resp = ConfirmedResponse(
                    requestId=req.requestId,
                    message=message,
                    ok=not timeout and args.processed and args.ok,
                )
                await call.write(resp)
        except asyncio.CancelledError:
            call.cancel()
            raise
        except Exception as e:
            error = e
        self._handle_stream_end("ControlClient", gen, error, lambda: self._spawn(self._run_control_client(gen)))

    # ~~~~~~~~~~~~~~~~~~~ discovery ~~~~~~~~~~~~~~~~~~~

    async def process_discovery_broadcast(
        self,
        args: UmbraDiscoveryBroadcastEventArgs,
        process_requests: Optional[Callable[[Sequence[SetNetworkPropertyRequest]], Any]],
        autoconnect_function: Optional[Callable[[str, int], Awaitable[EAutoconnectResult]]],
        local_ips: Iterable[str],
    ) -> None:
        """Handles an Umbra discovery broadcast.

        Informs that Umbra that this client exists (passing any network property requests it
        returns to ``process_requests``) and, if this client is not connected yet and the
        network IDs match, calls ``autoconnect_function(host, port)`` for each Umbra IP until
        one succeeds.

        ``local_ips`` are the local IP addresses including loopback; if they equal the Umbra's
        IPs, localhost is tried first.
        """
        dgram = args.broadcast
        remote_address = args.end_point[0]

        if not dgram.HasField("umbraServer") or not dgram.umbraServer.HasField("clientInfo"):
            return
        umbra = dgram.umbraServer.clientInfo
        local_ip_set = set(local_ips)
        loopback = "127.0.0.1"

        async def do_try_all_ips(action: Callable[[str, int], Awaitable[tuple[Optional[bool], Optional[T]]]]) -> Optional[T]:
            target = remote_address
            to_try = list(dict.fromkeys(umbra.ips))  # ordered set
            if set(to_try) == local_ip_set and loopback in to_try:
                # same IPs mean running on the same computer, therefore trying localhost first
                if self._auto_connection_in_progress:
                    self.logger.info(
                        "Same IP Addresses detected [%s], prefering Localhost to connect first", ", ".join(umbra.ips)
                    )
                target = loopback

            done: Optional[bool] = None
            result: Optional[T] = None
            if target in to_try:
                to_try.remove(target)
                done, result = await action(target, umbra.umbraPort)
            else:
                self.logger.warning(
                    "Received Umbra Broadcast from IP %s, using IP %s but that is not listed in Umbra IPs: [%s]",
                    remote_address, target, ", ".join(umbra.ips),
                )

            while done is None and to_try:
                ip = to_try.pop(0)
                done, result = await action(ip, umbra.umbraPort)

            if done is None:
                self.logger.warning("Unable to contact any of the Umbra %s IPs: [%s]", umbra.clientname, ", ".join(umbra.ips))
            return result

        async def inform_umbra_ask_for_actions(target: str, port: int) -> tuple[Optional[bool], Optional[ClientInfo]]:
            channel: Optional[grpc.aio.Channel] = None
            try:
                channel = self.data_provider.create_channel(target, port)
                stub = svc.DMXCNetServiceStub(channel)
                a = InformClientExistsRequest(info=self.data_provider.client_program_info)
                res = await stub.InformClientExists(a, metadata=self._md, timeout=CALL_TIMEOUT)
                if len(res.requests) > 0 and process_requests is not None:
                    r = process_requests(list(res.requests))
                    if inspect.isawaitable(r):
                        await r
                return True, (res.umbra.clientInfo if res.HasField("umbra") else None)
            except grpc.RpcError as e:
                code = _code(e)
                if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                    self.logger.debug("Timeout when connecting to Umbra %s @ %s", umbra.clientname, target)
                elif code == grpc.StatusCode.UNAVAILABLE:
                    self.logger.info("Unable to connect to Umbra %s @ %s", umbra.clientname, target)
                elif code != grpc.StatusCode.CANCELLED:
                    self.logger.debug("Unable to inform Source Umbra %s @ %s...", umbra.clientname, target, exc_info=True)
            except Exception:
                self.logger.debug("Unable to inform Source Umbra %s @ %s...", umbra.clientname, target, exc_info=True)
            finally:
                if channel is not None:
                    await channel.close()
            return None, None

        async def do_autoconnect(target: str, port: int) -> tuple[Optional[bool], None]:
            assert autoconnect_function is not None
            try:
                erg = await autoconnect_function(target, umbra.umbraPort)
                if erg == EAutoconnectResult.OK:
                    return True, None
                if erg == EAutoconnectResult.NotReady:
                    return False, None
            except LoginException as e:
                self.logger.error("Unable to Login to Umbra Server: %s", e)
            except asyncio.CancelledError:
                self.logger.warning("Connect Request cancelled")
                raise
            except Exception as e:
                self.logger.error("Exception when connecting to Umbra Server: %s", e)
            return None, None

        client_info = await do_try_all_ips(inform_umbra_ask_for_actions)

        # are we already connected?
        if self.session_id:
            connected = self.connected_to_umbra
            if connected is not None and umbra.runtimeid == connected.clientInfo.runtimeid and connected != dgram.umbraServer:
                self.connected_to_umbra = dgram.umbraServer
            return

        if autoconnect_function is None:
            return

        nid = self.data_provider.network_id
        unid = umbra.networkid if umbra.networkid.strip() else (client_info.networkid if client_info is not None else None)

        if nid == unid and not self._auto_connection_in_progress:
            try:
                self._auto_connection_in_progress = True
                await do_try_all_ips(do_autoconnect)
            finally:
                self._auto_connection_in_progress = False
