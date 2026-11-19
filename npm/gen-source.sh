#!/bin/bash
set -euo pipefail
shopt -s globstar
cd "$(dirname "$0")"

rm -rf dist
mkdir dist

# src/lib holds the hand-written helpers; everything else in src is generated
mkdir -p src
find src -mindepth 1 -maxdepth 1 ! -name lib -exec rm -rf {} +

protoc --plugin=./node_modules/.bin/protoc-gen-ts_proto \
 --ts_proto_out=src \
 --ts_proto_opt=outputServices=grpc-js \
 --ts_proto_opt=esModuleInterop=true \
 --ts_proto_opt=env=node \
 --ts_proto_opt=outputIndex=true \
 -I=../proto/ ../proto/**/*.proto

# export the helpers from the package root
echo 'export * from "./lib";' >> src/index.ts
