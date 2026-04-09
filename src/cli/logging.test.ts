import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "../utils/logger.js";
import { configureCliLogging, resolveCliLogLevel } from "./logging.js";

describe("CLI logging", () => {
  afterEach(() => {
    logger.setLevel("info");
    logger.setTerminalStream("stderr");
  });

  it("defaults CLI logs to error-only", () => {
    expect(resolveCliLogLevel({} as NodeJS.ProcessEnv)).toBe("error");
  });

  it("accepts an explicit CLI log level override", () => {
    expect(resolveCliLogLevel({ RAVI_CLI_LOG_LEVEL: "info" } as NodeJS.ProcessEnv)).toBe("info");
  });

  it("configures stderr output with the resolved level", () => {
    const setLevelSpy = spyOn(logger, "setLevel");
    const setTerminalStreamSpy = spyOn(logger, "setTerminalStream");

    configureCliLogging({ RAVI_CLI_LOG_LEVEL: "warn" } as NodeJS.ProcessEnv);

    expect(setTerminalStreamSpy).toHaveBeenCalledWith("stderr");
    expect(setLevelSpy).toHaveBeenCalledWith("warn");

    setLevelSpy.mockRestore();
    setTerminalStreamSpy.mockRestore();
  });
});
