import { describe, expect, test } from "bun:test";
import {
  describeTool,
  failureNotice,
  finishNotice,
  permissionNotice,
  questionNotice,
} from "../../src/broker/notices.ts";

// Plan 2.7: what each notice says; a ping-only folder's notices hold none of Claude's text (D8).
const devServer = {
  type: "shell",
  status: "running",
  description: "Dev server",
  command: "npm run dev",
};

describe("✅ a finished turn", () => {
  test("the reply, with running background work listed first", () => {
    const notice = finishNotice("sandbox · b1e8", "All done.", [devServer], "full");
    expect(notice).toEqual({
      header: "✅ sandbox · b1e8",
      body: "⏳ 1 background task still running:\n• shell: npm run dev (Dev server)\n\nAll done.",
    });
  });

  test("ping-only: no reply and no task names, only a count", () => {
    const notice = finishNotice("app · 67c6", "Secret plans.", [devServer, devServer], "ping-only");
    expect(notice.body).not.toContain("Secret plans");
    expect(notice.body).not.toContain("npm run dev");
    expect(notice.body).toStartWith("⏳ 2 background tasks still running.");
  });

  test("more than five tasks: the rest are counted", () => {
    const tasks = Array.from({ length: 7 }, (_, index) => ({
      ...devServer,
      command: `job ${index}`,
    }));
    const notice = finishNotice("x · 1234", "ok", tasks, "full");
    expect(notice.body).toContain("• and 2 more");
    expect(notice.body).not.toContain("job 5");
  });
});

describe("🔐 ❓ ⚠️", () => {
  test("a permission: the command to approve, then where to answer", () => {
    const notice = permissionNotice("sandbox · b1e8", "Bash", { command: "rm -rf build" }, "full");
    expect(notice).toEqual({
      header: "🔐 sandbox · b1e8 is waiting for your permission",
      body: "Bash: rm -rf build\n\nAnswer it at the Mac.",
    });
    expect(permissionNotice("x · 1", "Bash", { command: "rm -rf build" }, "ping-only").body).toBe(
      "Bash\n\nAnswer it at the Mac.",
    );
  });

  test("a question with its options; ping-only keeps the question at the Mac", () => {
    const questions = [
      { question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] },
    ];
    expect(questionNotice("x · 1", questions, "full").body).toBe(
      "Which color?\n• Red\n• Blue\n\nAnswer it at the Mac.",
    );
    expect(questionNotice("x · 1", questions, "ping-only").body).not.toContain("color");
  });

  test("an API error names its code", () => {
    expect(failureNotice("x · 1", "rate_limit")).toEqual({
      header: "⚠️ x · 1 stopped on an API error",
      body: "Error: rate_limit",
    });
  });

  test("a tool is described by its command, file or URL, else its input, capped", () => {
    expect(describeTool("Edit", { file_path: "/a/b.ts", old_string: "x" })).toBe("Edit: /a/b.ts");
    expect(describeTool("WebFetch", { url: "https://example.com" })).toBe(
      "WebFetch: https://example.com",
    );
    expect(describeTool("mcp__x__y", { big: "z".repeat(2000) })).toEndWith("…");
  });
});
