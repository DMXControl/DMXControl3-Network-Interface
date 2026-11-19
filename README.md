# DMXControl 3 Network Interface
[DMXControl 3](https://www.dmxcontrol.de/de/dmxcontrol-3/funktionen.html) uses [gRPC](https://grpc.io/) for its internal network communication since version 3.3.0. The protocol specification is done with [Protobuf files](https://protobuf.dev/). This repository makes the required Protobuf files to communicate with DMXControl 3 publicly available. It can be used to write your own applications which can connect to the DMXControl 3 Network.

# Content
Starting with DMXControl 3.3.0, there is a commit for every final release version of DMXControl. Each commit is tagged with the respective version tag and represents the latest version of the DMXControl 3 network interface at that time.

# Packages
Client libraries generated from the Protobuf files are built and published automatically by GitHub Actions whenever a version tag (`v*`) is pushed. The package version is taken from the tag (e.g. `v3.3.2` → `3.3.2`).

| Language | Package | Source |
|---|---|---|
| TypeScript / JavaScript | [`@dmxcontrolprojects/dmxc-grpc-client`](https://www.npmjs.com/package/@dmxcontrolprojects/dmxc-grpc-client) (npm) | [`npm/`](npm) |
| Python | [`dmxc_protobuf`](https://pypi.org/project/dmxc_protobuf/) (PyPI) | [`python/dmxc_protobuf/`](python/dmxc_protobuf) |

Besides the generated code, both packages contain ports of the helpers in [`csharp/`](csharp) (`UmbraConnectionClient`, `UmbraDiscoveryClient`, `NetConstants`, the `TranslateableData` builder and the message extensions). See the package READMEs for details.

To build locally (requires `protoc`):
- npm: `cd npm && npm ci && npm run build && npm test`
- Python: `cd python/dmxc_protobuf && poetry install && poetry run ./build.sh && poetry run python -m unittest discover -s tests -t . && poetry build`

# Important Notice
**We will not directly accept PRs here** because this repository is a read-only copy of the internal Protobuf specification repository. However, if approved, we will copy the changes to the internal repository, and they will then appear in the commit for one of the following DMXControl 3 releases.
