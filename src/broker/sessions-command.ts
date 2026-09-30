import type { Config } from "../shared/config.ts";
import { contentModeFor } from "../shared/scope.ts";
import { sessionTitle } from "../shared/title.ts";
import { sessionList } from "./session-list.ts";
import { cleanTitle, type Session, type Sessions } from "./sessions.ts";
import { type WriteToDeps, writeTo } from "./write-to.ts";

/**
 * /sessions, and a tap on one of its sessions to write to it (plans 7.3 to 7.5). Each session's title is
 * read from its transcript then, where its folder shows Claude's text (D8), and kept for the messages
 * after.
 */
export function sessionsParts(deps: WriteToDeps & { readonly sessions: Sessions }, config: Config) {
  const { sessions, log } = deps;
  const titleOf = (session: Session) => {
    if (session.transcript === "" || contentModeFor(config, session.projectDir) !== "full") {
      return undefined;
    }
    const title = cleanTitle(sessionTitle(session.transcript, log) ?? "");
    if (title !== undefined) sessions.retitle(session.id, title);
    return title;
  };
  const listing = { ...deps, titleOf };
  return {
    list: () => sessionList(listing),
    write: (data: string, chat: number, queryId: string) => writeTo(data, chat, queryId, listing),
  };
}
