// The stand-in for the recognizer service, for the end-to-end tests: listens on `PORT` (8000,
// the real service's, by default) and answers the contract fixture named by `FIXTURE`
// (six-strings by default) with the status the real service gives it.
import { recognizerFailure } from "@studio/contracts";

import { answers, fixture, startFakeRecognizer } from "./fakeRecognizer";

const port = Number(process.env.PORT ?? 8000);
const name = process.env.FIXTURE ?? "six-strings";
const failure = recognizerFailure.safeParse(fixture(name));
const answering = !failure.success ? answers.recognized(name) : failure.data.error.code === "busy" ? answers.busy() : answers.failed(name);

const recognizer = await startFakeRecognizer({ port, answering });
console.log(`a stand-in recognizer answering ${name} at ${recognizer.url}`);
