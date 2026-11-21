// Minimal gRPC-Web server (application/grpc-web+proto over HTTP/1.1) for the tests. It
// speaks the same wire format as ASP.NET Core's UseGrpcWeb() or Envoy, so the client under
// test goes through nice-grpc-web's real fetch transport.
//
// Implementations: `async (request, call) => response` for unary methods and
// `async function* (request, call)` for server streaming methods. Throw
// `{ code, details }` to answer with a gRPC error. `call.headers` are the request headers,
// `call.signal` aborts when the client goes away.
import http from "node:http";

function frame(flag, payload) {
  const b = Buffer.alloc(5 + payload.length);
  b[0] = flag;
  b.writeUInt32BE(payload.length, 1);
  b.set(payload, 5);
  return b;
}

function trailer(code, details = "") {
  return frame(0x80, Buffer.from(`grpc-status:${code}\r\ngrpc-message:${encodeURIComponent(details)}\r\n`));
}

export async function startGrpcWebServer(services) {
  const routes = new Map();
  for (const [definition, impl] of services) {
    for (const [key, m] of Object.entries(definition.methods)) {
      if (impl[key]) routes.set(`/${definition.fullName}/${m.name}`, { m, fn: impl[key] });
    }
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    res.writeHead(200, { "content-type": "application/grpc-web+proto" });
    const route = routes.get(req.url);
    if (!route) return res.end(trailer(12, "unimplemented"));

    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const call = { headers: req.headers, signal: controller.signal };
    const request = route.m.requestType.decode(body.subarray(5, 5 + body.readUInt32BE(1)));
    const send = (msg) => res.write(frame(0, route.m.responseType.encode(route.m.responseType.fromPartial(msg)).finish()));
    try {
      if (route.m.responseStream) {
        for await (const msg of route.fn(request, call)) {
          if (controller.signal.aborted) return;
          send(msg);
        }
      } else {
        send(await route.fn(request, call));
      }
      res.end(trailer(0));
    } catch (e) {
      if (!controller.signal.aborted) res.end(trailer(e.code ?? 2, e.details ?? String(e)));
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}
