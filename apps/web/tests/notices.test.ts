// The server's notices to a tab (docs/spec/collab.md, sections 2.1 and 9). That a real provider
// then connects no more is in apps/server/tests/collabDepth.test.ts, against a real server.
import { expect, test } from "vitest";

import { lockWhenReadOnly, noticeOf, type NoticedProvider, stopWhenClosed } from "../src/notices";

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

test("the readOnly notice says why the score is locked, at every connection; any other is not one, and the socket is left be", () => {
  const { provider, send, stopped } = fakeProvider();
  const reasons: string[] = [];
  lockWhenReadOnly(provider, (reason) => reasons.push(reason));
  send('{"type":"closed","reason":"tooDeep"}');
  send('{"type":"readOnly","reason":"later"}');
  send("something else");
  expect(reasons).toEqual([]);
  send('{"type":"readOnly","reason":"missingMigration"}');
  send('{"type":"readOnly","reason":"migrationFailed"}');
  send('{"type":"readOnly","reason":"newerSchema"}');
  expect([stopped.count, reasons]).toEqual([0, ["missingMigration", "migrationFailed", "newerSchema"]]);
});
