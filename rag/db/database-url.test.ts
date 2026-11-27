import { describe, expect, it } from "vitest";
import { COMPOSE_DATABASE_URL, resolveDatabaseUrl } from "./database-url";

describe("resolveDatabaseUrl", () => {
  const noEnvFile = (): undefined => undefined;

  it("prefers an explicit environment variable", () => {
    const env = { DATABASE_URL: "postgres://set/by/caller" } as NodeJS.ProcessEnv;
    expect(resolveDatabaseUrl(env, noEnvFile)).toEqual({
      url: "postgres://set/by/caller",
      source: "environment",
    });
  });

  it("falls back to the compose URL rather than pg's default port", () => {
    // The bug: with nothing set, pg connected to 5432 while Postgres was on
    // 5433, so the error named a port nothing was ever configured to use.
    const { url, source } = resolveDatabaseUrl({} as NodeJS.ProcessEnv, noEnvFile);
    expect(source).toBe("default");
    expect(url).toBe(COMPOSE_DATABASE_URL);
    expect(url).toContain(":5433/");
  });

  it("reads the env file when the variable is not already set", () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const loader = (): string => {
        process.env.DATABASE_URL = "postgres://from/dot/env";
        return "/repo/.env";
      };
      expect(resolveDatabaseUrl({} as NodeJS.ProcessEnv, loader)).toEqual({
        url: "postgres://from/dot/env",
        source: "env file",
      });
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("falls back when the env file exists but sets no DATABASE_URL", () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { source } = resolveDatabaseUrl({} as NodeJS.ProcessEnv, () => "/repo/.env");
      expect(source).toBe("default");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
