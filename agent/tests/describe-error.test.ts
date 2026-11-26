import { describe, expect, it } from "vitest";
import { describeError, formatError } from "../src/describe-error.js";

describe("describeError", () => {
  it("takes only the first line, so a stack-ish message stays one line", () => {
    expect(describeError(new Error("boom\n    at thing (file.ts:1:1)"))).toEqual({
      message: "boom",
    });
  });

  it("keeps the HTTP status, which is the whole diagnosis for an API failure", () => {
    const err = Object.assign(new Error("404 model: claude-sonnet-4-6"), { status: 404 });
    expect(describeError(err)).toMatchObject({ status: 404 });
  });

  it("prefers the cause's code over the wrapper's", () => {
    // Drizzle wraps a pg error and sets its own code; the SQLSTATE underneath
    // is the one that names the actual failure.
    const cause = Object.assign(new Error('relation "agent_runs" does not exist'), {
      code: "42P01",
    });
    const err = Object.assign(new Error("Failed query: insert into agent_runs"), {
      code: "DRIZZLE_QUERY_ERROR",
      cause,
    });
    expect(describeError(err)).toEqual({
      message: "Failed query: insert into agent_runs",
      cause: 'relation "agent_runs" does not exist',
      code: "42P01",
    });
  });

  it("does not invent detail for a non-Error throw", () => {
    expect(describeError("nope")).toEqual({ message: "run failed" });
    expect(describeError(undefined)).toEqual({ message: "run failed" });
  });
});

describe("formatError", () => {
  it("renders every part it has, in diagnosis order", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    const err = Object.assign(new Error("fetch failed"), { cause });
    expect(formatError(err)).toBe(
      "fetch failed code=ECONNREFUSED cause=connect ECONNREFUSED 127.0.0.1:11434",
    );
  });

  it("omits what is absent rather than printing undefined", () => {
    expect(formatError(new Error("plain"))).toBe("plain");
  });

  it("keeps status=0 rather than dropping it as falsy", () => {
    const err = Object.assign(new Error("odd"), { status: 0 });
    expect(formatError(err)).toBe("odd status=0");
  });
});
