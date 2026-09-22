import { describe, expect, it } from "bun:test";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";

describe("markdownToSlackMrkdwn", () => {
  it("maps bold, italic, and strikethrough to Slack mrkdwn", () => {
    expect(markdownToSlackMrkdwn("this is **bold** text")).toBe("this is *bold* text");
    expect(markdownToSlackMrkdwn("this is __bold__ text")).toBe("this is *bold* text");
    expect(markdownToSlackMrkdwn("this is *italic* text")).toBe("this is _italic_ text");
    expect(markdownToSlackMrkdwn("this is ~~gone~~ text")).toBe("this is ~gone~ text");
    expect(markdownToSlackMrkdwn("***both***")).toBe("_*both*_");
  });

  it("turns headings into bold lines", () => {
    expect(markdownToSlackMrkdwn("# Title")).toBe("*Title*");
    expect(markdownToSlackMrkdwn("## Subtitle")).toBe("*Subtitle*");
    expect(markdownToSlackMrkdwn("### Deep **heading**")).toBe("*Deep heading*");
  });

  it("converts markdown links to Slack labeled links", () => {
    expect(markdownToSlackMrkdwn("see [docs](https://example.com/path)")).toBe("see <https://example.com/path|docs>");
    expect(markdownToSlackMrkdwn("pic ![alt](https://example.com/a.png)")).toBe("pic <https://example.com/a.png|alt>");
    expect(markdownToSlackMrkdwn("[**bold label**](https://example.com)")).toBe("<https://example.com|*bold label*>");
  });

  it("rewrites lists into Slack-friendly bullets and keeps ordered markers", () => {
    expect(markdownToSlackMrkdwn("- first\n- second")).toBe("• first\n• second");
    expect(markdownToSlackMrkdwn("* starred\n+ plus")).toBe("• starred\n• plus");
    expect(markdownToSlackMrkdwn("1. one\n2. two")).toBe("1. one\n2. two");
    expect(markdownToSlackMrkdwn("- item **one**")).toBe("• item *one*");
  });

  it("converts nested mixed CommonMark in one pass", () => {
    const input = [
      "# Status",
      "Please read the **guide** and the *notes* at [site](https://example.com).",
      "- first **item**",
      "- second with ~~old~~ text",
    ].join("\n");

    expect(markdownToSlackMrkdwn(input)).toBe(
      [
        "*Status*",
        "Please read the *guide* and the _notes_ at <https://example.com|site>.",
        "• first *item*",
        "• second with ~old~ text",
      ].join("\n"),
    );
  });

  it("leaves fenced code blocks and inline code untouched", () => {
    const fenced = ["```ts", "const bold = **not bold**", "```"].join("\n");
    expect(markdownToSlackMrkdwn(fenced)).toBe(fenced);
    expect(markdownToSlackMrkdwn("use `**raw**` and **bold**")).toBe("use `**raw**` and *bold*");
    expect(markdownToSlackMrkdwn("see `[text](https://example.com)`")).toBe("see `[text](https://example.com)`");
  });

  it("escapes &, <, and > outside code and Slack sequences", () => {
    expect(markdownToSlackMrkdwn("use A & B")).toBe("use A &amp; B");
    expect(markdownToSlackMrkdwn("1 < 2 and 3 > 2")).toBe("1 &lt; 2 and 3 &gt; 2");
    expect(markdownToSlackMrkdwn("keep &amp; already escaped")).toBe("keep &amp; already escaped");
    expect(markdownToSlackMrkdwn("compare `1 < 2`")).toBe("compare `1 < 2`");
    expect(markdownToSlackMrkdwn("> quoted")).toBe("> quoted");
    expect(markdownToSlackMrkdwn("[go](https://example.com?a=1&b=2)")).toBe("<https://example.com?a=1&amp;b=2|go>");
  });

  it("returns empty input unchanged", () => {
    expect(markdownToSlackMrkdwn("")).toBe("");
  });
});
