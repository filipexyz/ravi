import { describe, expect, it } from "bun:test";
import { formatDuration, parseVttTranscript, selectSubtitleLanguage } from "./youtube-subtitles.js";

describe("YouTube subtitle extraction helpers", () => {
  it("parses VTT cues into clean transcript text", () => {
    const vtt = `WEBVTT
Kind: captions
Language: pt

00:00:00.000 --> 00:00:02.000
<c>Olá &amp; bem-vindo</c>

00:00:02.000 --> 00:00:04.000
<00:00:02.200>ao Ravi</00:00:03.000>

00:00:04.000 --> 00:00:05.000
ao Ravi
`;

    expect(parseVttTranscript(vtt)).toBe("Olá & bem-vindo\nao Ravi");
  });

  it("selects subtitles by preferred language before falling back to prefixes", () => {
    expect(
      selectSubtitleLanguage({
        subtitles: { en: [{}] },
        automatic_captions: { "pt-BR": [{}], es: [{}] },
      }),
    ).toBe("pt-BR");

    expect(
      selectSubtitleLanguage({
        subtitles: { "pt-PT": [{}], en: [{}] },
        automatic_captions: {},
      }),
    ).toBe("pt-PT");
  });

  it("formats duration consistently", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(null)).toBe("unknown");
  });
});
