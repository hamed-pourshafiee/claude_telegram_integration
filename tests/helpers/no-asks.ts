import { ok } from "../../src/broker/answer.ts";
import type { AskChat } from "../../src/broker/ask-chat.ts";
import type { AskRelay } from "../../src/broker/ask-relay.ts";

// For tests of other parts: a broker where no question of Claude's waits in the chat (plan 4.1).

export const noAskRelay: Pick<
  AskRelay,
  "ask" | "confirm" | "end" | "asked" | "moved" | "sessionEnded"
> = {
  ask: () => ok({ state: "local" }),
  confirm: () => ok({ delivered: false }),
  end: () => ok({}),
  asked: () => undefined,
  moved: () => undefined,
  sessionEnded: () => undefined,
};

export const noAskChat: Pick<AskChat, "questionAt" | "asking" | "answerText"> = {
  questionAt: () => undefined,
  asking: () => [],
  answerText: () => ({ outcome: "closed" }),
};
