#!/bin/bash
set -euo pipefail
shopt -s globstar
cd "$(dirname "$0")"

rm -rf dist

# npm only packs a LICENSE from the package directory
cp ../LICENSE .
mkdir dist

# src/lib holds the hand-written web helpers; everything else in src is generated or copied
mkdir -p src
find src -mindepth 1 -maxdepth 1 ! -name lib -exec rm -rf {} +

# outputServices=nice-grpc + generic-definitions: service definitions for nice-grpc-web
# env=browser: bytes are Uint8Array (no Buffer), base64 via atob/btoa
# importSuffix=.js: the output is native ES modules
protoc --plugin=./node_modules/.bin/protoc-gen-ts_proto \
 --ts_proto_out=src \
 --ts_proto_opt=outputServices=nice-grpc,outputServices=generic-definitions \
 --ts_proto_opt=useExactTypes=false \
 --ts_proto_opt=esModuleInterop=true \
 --ts_proto_opt=env=browser \
 --ts_proto_opt=importSuffix=.js \
 --ts_proto_opt=outputIndex=true \
 -I=../proto/ ../proto/**/*.proto

mkdir src/shared

# make MessageFns nameable for the declaration files of the service definitions
node scripts/share-message-fns.mjs src

# the platform independent helpers are shared with the Node package (../npm/src/lib);
# they are copied (with .js import suffixes for ES modules) instead of duplicated
for f in Extensions I18N Logger NetConstants ProtobufTools; do
  sed -E 's#(from "\.\.?/[^"]+)"#\1.js"#' "../npm/src/lib/$f.ts" > "src/shared/$f.ts"
done

# export the helpers from the package root
{
  echo 'export * from "./shared/Extensions.js";'
  echo 'export * from "./shared/I18N.js";'
  echo 'export * from "./shared/Logger.js";'
  echo 'export * from "./shared/NetConstants.js";'
  echo 'export * from "./shared/ProtobufTools.js";'
  echo 'export * from "./lib/index.js";'
} >> src/index.ts
