// Checks the build output is browser friendly and the shared helpers work. Run `npm run build` first.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/index.js";
import * as sub from "@dmxcontrolprojects/dmxcontrol3-network-interface-web/LumosProtobuf";

const dist = new URL("../dist/", import.meta.url).pathname;

test("no Node built-ins or Buffer in the output", () => {
  for (const f of readdirSync(dist, { recursive: true }).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(dist, f), "utf8");
    assert.doesNotMatch(text, /from "(node:)?(fs|os|dgram|net|http2?|events|path)"/, f);
    assert.doesNotMatch(text, /\bBuffer\./, f);
  }
});

test("bytes fields are Uint8Array", () => {
  const T = lib.LumosProtobuf;
  const field = Object.entries(T).find(([, v]) => v?.fromPartial && Object.values(v.fromPartial({})).some((x) => x instanceof Uint8Array));
  assert.ok(field, "expected at least one message with a bytes field");
});

test("subpath exports", () => {
  assert.equal(sub.ClientProgramInfo, lib.LumosProtobuf.ClientProgramInfo);
});

test("shared helpers", () => {
  assert.equal(lib.containsNonAsciiCharacters("äbc"), true);
  assert.equal(lib.NetConstants.UMBRA_LISTEN_PORT, 17475);
  assert.equal(lib.colorIsWhite({ r: 255, g: 255, b: 255, a: 255 }), true);
  const t = lib._("Hello {0}", "x");
  assert.equal(lib.LumosProtobuf.TranslateableData.decode(lib.LumosProtobuf.TranslateableData.encode(t).finish()).key, t.key);
});

test("createUmbraChannel", () => {
  assert.equal(lib.createUmbraChannel("10.0.0.1").address, "http://10.0.0.1:17475");
  assert.equal(lib.createUmbraChannel("::1", 1, true).address, "https://[::1]:1");
});
