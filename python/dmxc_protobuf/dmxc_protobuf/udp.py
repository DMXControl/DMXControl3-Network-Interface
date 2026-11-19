"""UDP listener and Umbra discovery (multicast) client."""

from __future__ import annotations

import asyncio
import logging
import socket
from collections import deque
from dataclasses import dataclass
from typing import Iterable, Optional

from dmxc_protobuf import net_constants
from dmxc_protobuf.Common.Types.UmbraServiceTypes_pb2 import UmbraUdpBroadcast
from dmxc_protobuf.events import Event

EndPoint = tuple[str, int]


@dataclass(frozen=True)
class UdpEventArgs:
    data: bytes
    end_point: EndPoint


def get_local_ipv4_addresses(include_loopback: bool = False) -> list[str]:
    """IPv4 addresses of this machine.

    Uses the optional ``ifaddr`` package to list every interface when it is installed;
    otherwise falls back to the host name lookup and the address of the default route.
    """
    found: list[str] = []
    try:
        import ifaddr  # type: ignore[import-not-found]

        for adapter in ifaddr.get_adapters():
            for ip in adapter.ips:
                if isinstance(ip.ip, str):
                    found.append(ip.ip)
    except ImportError:
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                found.append(str(info[4][0]))
        except OSError:
            pass
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.0.2.1", 9))  # no packet is sent for UDP connect
                found.append(s.getsockname()[0])
        except OSError:
            pass

    result: list[str] = []
    for ip in found:
        is_loopback = ip.startswith("127.")
        if (include_loopback or not is_loopback) and ip not in result:
            result.append(ip)
    if include_loopback and "127.0.0.1" not in result:
        result.append("127.0.0.1")
    return result


class _Protocol(asyncio.DatagramProtocol):
    def __init__(self, owner: UdpListener) -> None:
        self._owner = owner

    def datagram_received(self, data: bytes, addr: tuple) -> None:  # type: ignore[override]
        if not self._owner.is_disposed:
            self._owner.udp_data_received.fire(UdpEventArgs(data, (addr[0], addr[1])))


class UdpListener:
    """UDP listener with address reuse and optional multicast membership."""

    def __init__(self, listen_port: int, multicast_ip: Optional[str] = None) -> None:
        self._listen_port = listen_port
        self._multicast_ip = multicast_ip
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._listening = False
        self.is_disposed = False
        self.udp_data_received: Event[[UdpEventArgs]] = Event()

    async def start_listen(self) -> None:
        if self._listening:
            raise RuntimeError("Already Listening")
        self._listening = True
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self._sock.bind(("", self._listen_port))
        self._sock.setblocking(False)
        loop = asyncio.get_running_loop()
        self._transport, _ = await loop.create_datagram_endpoint(lambda: _Protocol(self), sock=self._sock)

    def add_multicast_listen_ip_address(self, ip_address: str) -> None:
        """Joins the multicast group given in the constructor on the interface with ``ip_address``."""
        if self._multicast_ip is None:
            raise RuntimeError("MulticastIP not defined in constructor")
        if not ip_address:
            raise ValueError("ip_address")
        mreq = socket.inet_aton(self._multicast_ip) + socket.inet_aton(ip_address)
        self._sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)

    def dispose(self) -> None:
        if self.is_disposed:
            return
        self.is_disposed = True
        self.udp_data_received.clear()
        if self._transport is not None:
            self._transport.close()
        else:
            self._sock.close()

    close = dispose

    async def __aenter__(self) -> UdpListener:
        await self.start_listen()
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.dispose()


@dataclass(frozen=True)
class UmbraDiscoveryBroadcastEventArgs:
    broadcast: UmbraUdpBroadcast
    end_point: EndPoint


class UmbraDiscoveryClient:
    """Listens for the multicast discovery broadcasts Umbra servers send.

    Subscribe to :attr:`umbra_discovery_broadcast_received` and call :meth:`start_discovery`.
    """

    def __init__(self, logger: Optional[logging.Logger] = None) -> None:
        self.logger = logger or logging.getLogger(__name__)
        self.broadcast_history_max = 100
        self.umbra_discovery_broadcast_received: Event[[UmbraDiscoveryBroadcastEventArgs]] = Event()
        self._listener: Optional[UdpListener] = None
        self._received: deque[UmbraUdpBroadcast] = deque()

    def get_broadcast_history(self, from_new_to_old: bool, limit: int) -> list[UmbraUdpBroadcast]:
        items = list(self._received)
        if from_new_to_old:
            items.reverse()
        if 0 < limit < len(items):
            items = items[:limit]
        return items

    async def start_discovery(self, listen_addresses: Optional[Iterable[str]] = None) -> None:
        """Starts listening. Without ``listen_addresses``, the multicast group is joined on all
        non-loopback IPv4 addresses found by :func:`get_local_ipv4_addresses`."""
        addresses = list(listen_addresses) if listen_addresses is not None else get_local_ipv4_addresses()

        if self._listener is not None:
            self._listener.dispose()

        listener = UdpListener(net_constants.DMXCNET_MULTICAST_PORT, net_constants.DMXCNET_MULTICAST_ADDRESS)
        self._listener = listener
        await listener.start_listen()

        if not addresses:
            self.logger.warning("Network not available. Only listening Broadcast")
        else:
            for a in addresses:
                try:
                    self.logger.info("Listening on %s for Umbra Multicasts", a)
                    listener.add_multicast_listen_ip_address(a)
                except OSError:
                    self.logger.warning("Unable to Listen on IP Address: %s", a)

        listener.udp_data_received += self._on_udp_data

    def dispose(self) -> None:
        if self._listener is not None:
            self._listener.dispose()
            self._listener = None
        self.umbra_discovery_broadcast_received.clear()

    close = dispose

    def _on_udp_data(self, args: UdpEventArgs) -> None:
        try:
            d = UmbraUdpBroadcast.FromString(args.data)
        except Exception as e:  # DecodeError
            self.logger.debug("Unable to deserialize Data: %s", e)
            return
        d.sourceEndPoint = args.end_point[0]
        self._received.append(d)
        while len(self._received) > self.broadcast_history_max:
            self._received.popleft()
        self.umbra_discovery_broadcast_received.fire(UmbraDiscoveryBroadcastEventArgs(d, args.end_point))
