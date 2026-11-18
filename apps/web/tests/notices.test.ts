// The server's notices to a tab (docs/spec/collab.md, sections 2.1 and 9). That a real provider
// then connects no more is in apps/server/tests/collabDepth.test.ts, against a real server.
import { expect, test } from "vitest";

import { noticeOf, type NoticedProvider, stopWhenClosed } from "../src/notices";

test("a notice is read from its payload; anything else is none", () => {
  expect(noticeOf('{"type":"closed","reason":"tooDeep"}')).toEqual({ type: "closed", reason: "tooDeep" });
  expect(noticeOf('{"type":"readOnly","reason":"newerSchema"}')).toEqual({ type: "readOnly", reason: "newerSchema" });
  expect(noticeOf('{"type":"closed","reason":"later"}')).toBeNull();
  expect(noticeOf("not JSON")).toBeNull();
});

/** A provider that hears what a test says the server sends, and counts the times its socket is stopped. */
function fakeProvider() {
  const listeners: ((data: { payload: string }) => void)[] = [];
  const stopped = { count: 0 };
  const provider: NoticedProvider = {
    on: (_event, listener) => listeners.push(listener),
    configuration: { websocketProvider: { disconnect: () => (stopped.count += 1) } },
  };
  const send = (payload: string) => listeners.forEach((listener) => listener({ payload }));
  return { provider, send, stopped };
}

test("the closed notice stops the provider's socket and says why; any other leaves it be", () => {
  const { provider, send, stopped } = fakeProvider();
  const reasons: string[] = [];
  stopWhenClosed(provider, (reason) => reasons.push(reason));
  send('{"type":"readOnly","reason":"newerSchema"}');
  send("something else");
  expect([stopped.count, reasons]).toEqual([0, []]);
  send('{"type":"closed","reason":"tooDeep"}');
  expect([stopped.count, reasons]).toEqual([1, ["tooDeep"]]);
});
