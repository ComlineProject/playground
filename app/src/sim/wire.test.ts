/// Headless (`node --test`) proof that route B is a working, faithful wire:
///   - a call and a raised error round-trip over a real `duplex()`
///   - every frame reaches the tap
///   - the frames `GenericDispatch` produces are byte-identical to the ones the
///     committed generated `chat.ts` fixture produces (the drift guard)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initWasm, { describe_project } from "../wasm/comline_playground_wasm.js";
import type { ProjectShape, ProtocolShape } from "./shape.ts";
import {
  Client,
  DatagramFraming,
  Handshake,
  JsonCodec,
  JsonRpcFraming,
  Server,
  type Codec,
  type Framing,
} from "./runtime/index.ts";
import { GenericClient, GenericDispatch, SimRemoteError, type BehaviorMap } from "./generic.ts";
import { wire } from "./transport.ts";
import { ChatClient, serveChat } from "./runtime/_fixture_chat.ts";

await initWasm(
  readFileSync(fileURLToPath(new URL("../wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);

const CHAT_IDS = `struct Message {
    body: string
    seq: u64
}

error Rejected {
    message = "rejected: {self.reason}"
    reason: string
}

protocol Chat {
    function send(text: string) -> Message ! Rejected;
    function history(limit: u64) -> Message[];
    function wipe();
    function note(text: string);
}
`;

function chatShape(framing?: '"jsonrpc"' | '"datagram"'): {
  proto: ProtocolShape;
  irHash: string;
} {
  const src = framing ? CHAT_IDS.replace("protocol Chat", `@framing = ${framing}\nprotocol Chat`) : CHAT_IDS;
  const shape = describe_project([{ path: "chat.ids", source: src }]) as ProjectShape;
  const schema = shape.schemas.find((s) => s.namespace === "chat")!;
  return { proto: schema.protocols[0], irHash: schema.ir_hash };
}

/** Stand up a generic client ⇄ server pair on a tapped wire. */
async function connect(
  proto: ProtocolShape,
  irHash: string,
  behaviors: BehaviorMap,
  codec: Codec,
  framing: () => Framing,
) {
  const w = wire("client", "server");
  const hs = () =>
    new Handshake({ irHash: BigInt(irHash), wireFormat: codec.name, framing: framing().name });
  const server = new Server(new GenericDispatch(proto, behaviors), codec, framing());
  void server.serveHandshaked(w.b, hs());
  const client = new GenericClient(await Client.connect(w.a, codec, hs(), framing()), proto);
  return { w, client };
}

const MESSAGE = { body: "HELLO", seq: 7 };

test("send round-trips a decoded reply (datagram)", async () => {
  const { proto, irHash } = chatShape();
  const { w, client } = await connect(
    proto,
    irHash,
    { send: { run: () => ({ kind: "ok", value: MESSAGE }) } },
    new JsonCodec(),
    () => new DatagramFraming(),
  );
  w.tap.clear();

  const reply = await client.call("send", { text: "hi" });
  assert.deepEqual(reply, MESSAGE);
  assert.equal(w.tap.frames.length, 2, "one request frame, one response frame");
  assert.deepEqual(
    w.tap.frames.map((f) => [f.from, f.to]),
    [
      ["client", "server"],
      ["server", "client"],
    ],
  );
  w.close();
});

test("send round-trips over JSON-RPC framing", async () => {
  const { proto, irHash } = chatShape('"jsonrpc"');
  assert.equal(proto.framing, "jsonrpc");
  const { w, client } = await connect(
    proto,
    irHash,
    { send: { run: () => ({ kind: "ok", value: MESSAGE }) } },
    new JsonCodec(),
    () => new JsonRpcFraming(),
  );
  w.tap.clear();

  assert.deepEqual(await client.call("send", { text: "hi" }), MESSAGE);
  assert.ok(
    w.tap.frames.every((f) => f.bytes[0] === 0x7b /* '{' */),
    "JSON-RPC frames are text",
  );
  w.close();
});

test("a raised error comes back as SimRemoteError with the ordinal's name", async () => {
  const { proto, irHash } = chatShape();
  const { w, client } = await connect(
    proto,
    irHash,
    { send: { run: () => ({ kind: "err", ordinal: 0, data: { reason: "nope" } }) } },
    new JsonCodec(),
    () => new DatagramFraming(),
  );

  await assert.rejects(
    () => client.call("send", { text: "hi" }),
    (e: unknown) => {
      assert.ok(e instanceof SimRemoteError);
      assert.equal(e.ordinal, 0);
      assert.equal(e.errorName, "Rejected");
      assert.deepEqual(e.data, { reason: "nope" });
      return true;
    },
  );
  w.close();
});

test("a one-way call sends a request and expects no response", async () => {
  const { proto, irHash } = chatShape();
  let got: unknown;
  const { w, client } = await connect(
    proto,
    irHash,
    { note: { run: (cx) => ((got = cx.params), { kind: "none" }) } },
    new JsonCodec(),
    () => new DatagramFraming(),
  );
  w.tap.clear();

  assert.equal(await client.call("note", { text: "fyi" }), undefined);
  await new Promise((r) => setTimeout(r, 0)); // let the server run
  assert.deepEqual(got, { text: "fyi" });
  assert.equal(w.tap.frames.length, 1, "request only, no reply");
  w.close();
});

test("drift guard — GenericDispatch frames match the generated ChatDispatcher", async () => {
  const { proto, irHash } = chatShape();
  const codec = new JsonCodec();
  const stub = () => ({ kind: "ok" as const, value: MESSAGE });

  // route B
  const g = await connect(
    proto,
    irHash,
    {
      send: { run: stub },
      history: { run: () => ({ kind: "ok", value: [] }) },
      wipe: { run: () => ({ kind: "none" }) },
      note: { run: () => ({ kind: "none" }) },
    },
    codec,
    () => new DatagramFraming(),
  );
  g.w.tap.clear();
  await g.client.call("send", { text: "hi" });
  const routeB = g.w.tap.frames.map((f) => Buffer.from(f.bytes).toString("hex"));
  g.w.close();

  // the committed generated fixture
  const f = wire("client", "server");
  void serveChat(
    {
      send: async () => MESSAGE,
      history: async () => [],
      wipe: async () => {},
      note: async () => {},
    },
    f.b,
    codec,
    new DatagramFraming(),
  );
  const fixtureClient = await ChatClient.connect(f.a, codec, new DatagramFraming());
  f.tap.clear();
  await fixtureClient.send({ text: "hi" });
  const generated = f.tap.frames.map((fr) => Buffer.from(fr.bytes).toString("hex"));
  f.close();

  assert.deepEqual(routeB, generated);
});
