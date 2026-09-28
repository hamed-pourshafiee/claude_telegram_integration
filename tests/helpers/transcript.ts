// Transcript entries shaped like Claude Code's (2.1.274 and 2.1.283, as recorded in this repo's build
// transcripts; F16): each entry points to the one before it with parentUuid.

type Entry = Record<string, unknown>;

export class Transcript {
  readonly entries: Entry[] = [];
  #count = 0;
  #last: string | undefined;

  /** A prompt typed by the user: the turn's first user entry, with its promptId. */
  prompt(promptId: string, text = "a prompt"): this {
    return this.#add({ type: "user", promptId, message: { role: "user", content: text } });
  }

  /**
   * An assistant message. Several text blocks go in one entry each, with the same message id, as
   * Claude Code writes them; last_assistant_message joins them with "\n".
   */
  assistant(text: string | readonly string[], messageId = `msg_${this.#count}`): this {
    for (const block of typeof text === "string" ? [text] : text) {
      const content = [{ type: "text", text: block }];
      this.#add({ type: "assistant", message: { id: messageId, role: "assistant", content } });
    }
    return this;
  }

  thinking(messageId = `msg_${this.#count}`): this {
    const content = [{ type: "thinking", thinking: "…" }];
    return this.#add({ type: "assistant", message: { id: messageId, role: "assistant", content } });
  }

  /** A tool's result: a user entry of the same turn. */
  toolResult(promptId: string): this {
    const content = [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }];
    return this.#add({ type: "user", promptId, message: { role: "user", content } });
  }

  /** What Claude Code writes when a Stop hook blocks: a meta message, then the error attachment. */
  blocked(promptId: string): this {
    this.#add({ type: "user", isMeta: true, promptId, message: { content: "Stop hook feedback" } });
    return this.attachment("hook_blocking_error");
  }

  attachment(kind: string): this {
    return this.#add({ type: "attachment", attachment: { type: kind, hookName: "Stop" } });
  }

  /** The stop's summary, once the synchronous Stop hooks are done. */
  summary(fields: Entry = {}): this {
    return this.#add({
      type: "system",
      subtype: "stop_hook_summary",
      hookCount: 1,
      hookErrors: [],
      preventedContinuation: false,
      ...fields,
    });
  }

  /** The transcript as a JSONL file's text. */
  jsonl(): string {
    return this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  }

  #add(fields: Entry): this {
    this.#count += 1;
    const uuid = `uuid-${this.#count}`;
    this.entries.push({ parentUuid: this.#last ?? null, uuid, timestamp: "", ...fields });
    this.#last = uuid;
    return this;
  }
}
