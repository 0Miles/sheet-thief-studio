// The stand-in for the recognizer service, for the end-to-end tests: listens on `PORT` (8000,
// the real service's, by default) and answers the contract fixture named by `FIXTURE`
// (six-strings by default) with the status the real service gives it. A test that needs another
// answer asks for it first: `PUT /fixture/<name>` answers that fixture from then on.
import { recognizerFailure } from "@studio/contracts";

import { answers, fixture, fixtureNames, startFakeRecognizer } from "./fakeRecognizer";

/** What the real service answers with this fixture. */
function answerOf(name: string) {
  const failure = recognizerFailure.safeParse(fixture(name));
  return !failure.success ? answers.recognized(name) : failure.data.error.code === "busy" ? answers.busy() : answers.failed(name);
}

const port = Number(process.env.PORT ?? 8000);
const name = process.env.FIXTURE ?? "six-strings";

const recognizer = await startFakeRecognizer({
  port,
  answering: answerOf(name),
  onControl: (fixtureName) => {
    if (!fixtureNames().includes(fixtureName)) return false;
    recognizer.answer(answerOf(fixtureName));
    return true;
  },
});
console.log(`a stand-in recognizer answering ${name} at ${recognizer.url}`);
