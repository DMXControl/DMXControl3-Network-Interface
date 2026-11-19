"""Addresses and ports DMXControl 3 programs listen on.

(12346-12545 are unassigned according to IANA.)
"""

#: Multicast address used for discovery. 68 = D, 67 = C => 225.D.C.3
DMXCNET_MULTICAST_ADDRESS = "225.68.67.3"

NETMANAGER_KERNEL_JSON_SEND_PORT = 23242

#: Port used for discovery
DMXCNET_MULTICAST_PORT = 17474

#: Port of the Umbra broker (since 3.3). 17475 is 0x4443, which is ASCII "DC"
UMBRA_LISTEN_PORT = 17475
UMBRA_LISTEN_PORT_SECURE = 17476

#: Maximum size of a gRPC message (50 MB)
MAX_MESSAGE_SIZE = 50 * 1024 * 1024

#: Maximum size of a file to be sent directly as bytes (5 MB)
MAX_RESOURCE_DIRECT_SEND_SIZE = 5 * 1024 * 1024
