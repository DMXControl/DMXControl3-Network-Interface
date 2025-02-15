# DMXControl 3 Network Interface
[DMXControl 3](https://www.dmxcontrol.de/de/dmxcontrol-3/funktionen.html) uses [gRPC](https://grpc.io/) for its internal network communication since version 3.3.0. The protocol specification is done with [Protobuf files](https://protobuf.dev/). This repository makes the required Protobuf files to communicate with DMXControl 3 publicly available. It can be used to write your own applications which can connect to the DMXControl 3 Network.

# Content
Starting with DMXControl 3.3.0, there is a commit for every final release version of DMXControl. Each commit is tagged with the respective version tag and represents the latest version of the DMXControl 3 network interface at that time.

# Important Notice
**We will not directly accept PRs here** because this repository is a read-only copy of the internal Protobuf specification repository. However, if approved, we will copy the changes to the internal repository, and they will then appear in the commit for one of the following DMXControl 3 releases.
