#!/bin/bash
set -euo pipefail
shopt -s globstar
cd "$(dirname "$0")"

PROTO_DIR=../../proto
OUT=dmxc_protobuf

# poetry only bundles a LICENSE from the project directory
cp ../../LICENSE .

rm -rf "$OUT/Client" "$OUT/Common" "$OUT/Server"

python -m grpc_tools.protoc -I "$PROTO_DIR" \
  --python_out="$OUT" --pyi_out="$OUT" --grpc_python_out="$OUT" \
  "$PROTO_DIR"/**/*.proto

# protoc emits absolute imports ("from Common.Types ...") that only work when the
# proto root is on sys.path; rewrite them to package imports.
find "$OUT" \( -name '*_pb2.py' -o -name '*_pb2.pyi' -o -name '*_pb2_grpc.py' \) -print0 |
  xargs -0 sed -i -E 's/^(from|import) (Client|Common|Server)([. ])/\1 dmxc_protobuf.\2\3/'

find "$OUT" -mindepth 1 -type d -exec touch {}/__init__.py \;
