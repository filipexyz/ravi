import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { ModelPicker, type ModelPickerProps, type ModelPickerSelection } from "./ModelPicker.js";

async function renderPicker(
  currentModel: string | null,
  size = { width: 100, height: 32 },
  currentProvider: ModelPickerProps["currentProvider"] = "claude",
) {
  const onApply = mock((_selection: ModelPickerSelection) => {});
  const onClose = mock(() => {});
  const setup = await testRender(
    createElement(ModelPicker, { agentId: "test", currentProvider, currentModel, onApply, onClose }),
    { ...size, useThread: false, exitOnCtrlC: false, kittyKeyboard: true },
  );
  await setup.renderOnce();
  return {
    ...setup,
    onApply,
    onClose,
    async press(input: () => void) {
      await act(async () => input());
      await setup.renderOnce();
    },
    async cleanup() {
      await act(async () => setup.renderer.destroy());
    },
  };
}

describe("ModelPicker configured model", () => {
  for (const size of [
    { width: 100, height: 32 },
    { width: 120, height: 40 },
  ]) {
    test.each(["fable", "claude-mythos-5", "claude-opus-4-6", "claude-haiku-4-5", "claude-fable-6"])(
      `shows and confirms %s at ${size.width}x${size.height}`,
      async (model) => {
        const picker = await renderPicker(model, size);
        try {
          expect(picker.captureCharFrame()).toContain(`▶ ${model}`);
          expect(picker.captureCharFrame()).toContain(`Next runtime: claude/${model}`);
          await picker.press(() => picker.mockInput.pressTab());
          await picker.press(() => picker.mockInput.pressEnter());
          expect(picker.onApply.mock.calls).toEqual([[{ provider: "claude", model }]]);
        } finally {
          await picker.cleanup();
        }
      },
    );
  }

  test("keeps the current option available while deliberately selecting a catalog model", async () => {
    const picker = await renderPicker("fable");
    try {
      await picker.press(() => picker.mockInput.pressTab());
      await picker.press(() => picker.mockInput.pressArrow("down"));
      expect(picker.captureCharFrame()).toContain("▶ sonnet");
      expect(picker.captureCharFrame()).toContain("Next runtime: claude/sonnet");
      await picker.press(() => picker.mockInput.pressArrow("up"));
      expect(picker.captureCharFrame()).toContain("▶ fable");
      await picker.press(() => picker.mockInput.pressArrow("down"));
      await picker.press(() => picker.mockInput.pressEnter());
      expect(picker.onApply.mock.calls).toEqual([[{ provider: "claude", model: "sonnet" }]]);
    } finally {
      await picker.cleanup();
    }
  });

  test.each([null, "", "   "])("uses the default for an absent model %s", async (model) => {
    const picker = await renderPicker(model);
    try {
      expect(picker.captureCharFrame()).toContain("▶ sonnet");
      await picker.press(() => picker.mockInput.pressTab());
      await picker.press(() => picker.mockInput.pressEnter());
      expect(picker.onApply.mock.calls).toEqual([[{ provider: "claude", model: "sonnet" }]]);
    } finally {
      await picker.cleanup();
    }
  });

  test("retains a configured model for another supported provider", async () => {
    const picker = await renderPicker("grok-future", undefined, "grok");
    try {
      expect(picker.captureCharFrame()).toContain("▶ grok-future");
      expect(picker.captureCharFrame()).toContain("Next runtime: grok/grok-future");
      await picker.press(() => picker.mockInput.pressTab());
      await picker.press(() => picker.mockInput.pressEnter());
      expect(picker.onApply.mock.calls).toEqual([[{ provider: "grok", model: "grok-future" }]]);
    } finally {
      await picker.cleanup();
    }
  });

  test("cancels without applying a model", async () => {
    const picker = await renderPicker("fable");
    try {
      await picker.press(() => picker.mockInput.pressEscape());
      expect(picker.onClose).toHaveBeenCalledTimes(1);
      expect(picker.onApply).not.toHaveBeenCalled();
    } finally {
      await picker.cleanup();
    }
  });
});
