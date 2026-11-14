import { expect, it } from "bun:test";
import { OUTDATED_PM2_BANNER, runWithPm2Jlist } from "../test/pm2-jlist.js";

it("preserves runner settings from a PM2 snapshot with the version warning", () => {
  const entry = { name: "ravi-channels", pm2_env: { env: { RAVI_CHANNELS_CONSUME_OUTBOUND: "0" } } };
  const result = runWithPm2Jlist(
    OUTDATED_PM2_BANNER + JSON.stringify([entry]),
    `import { buildRunnerPm2Env } from ${JSON.stringify(new URL("./pm2-env.ts", import.meta.url).href)};
     const retained = buildRunnerPm2Env();
     process.env.RAVI_CHANNELS_CONSUME_OUTBOUND = "1";
     console.log(JSON.stringify({ retained, overridden: buildRunnerPm2Env() }));`,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    retained: { RAVI_CHANNELS_CONSUME_OUTBOUND: "0" },
    overridden: { RAVI_CHANNELS_CONSUME_OUTBOUND: "1" },
  });
});
