/** @jsxImportSource @opentui/react */

import { useMemo, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { RuntimeProviderId } from "../../runtime/types.js";
import {
  getDefaultModelForProvider,
  listRuntimeModels,
  listRuntimeProviders,
  resolvePreferredRuntimeModel,
} from "../../runtime/model-catalog.js";

type FocusZone = "provider" | "model";

export interface ModelPickerSelection {
  provider: RuntimeProviderId;
  model: string;
}

export interface ModelPickerProps {
  agentId: string;
  currentProvider: RuntimeProviderId;
  currentModel: string | null;
  onApply: (selection: ModelPickerSelection) => void;
  onClose: () => void;
}

export function ModelPicker({ agentId, currentProvider, currentModel, onApply, onClose }: ModelPickerProps) {
  const renderer = useRenderer();
  const providerOptions = useMemo(
    () =>
      listRuntimeProviders().map((option) => ({
        name: option.name,
        description: option.description,
        value: option.id,
      })),
    [],
  );

  const initialProviderIndex = Math.max(
    0,
    providerOptions.findIndex((option) => option.value === currentProvider),
  );

  const [providerIndex, setProviderIndex] = useState(initialProviderIndex);
  const [focusZone, setFocusZone] = useState<FocusZone>("provider");
  const [modelByProvider, setModelByProvider] = useState<Record<RuntimeProviderId, string>>(() => ({
    claude: resolvePreferredRuntimeModel("claude", currentProvider === "claude" ? currentModel : null),
    codex: resolvePreferredRuntimeModel("codex", currentProvider === "codex" ? currentModel : null),
  }));

  const selectedProvider = (providerOptions[providerIndex]?.value as RuntimeProviderId | undefined) ?? "claude";
  const modelOptions = useMemo(
    () =>
      listRuntimeModels(selectedProvider).map((option) => ({
        name: option.name,
        description: option.description,
        value: option.id,
      })),
    [selectedProvider],
  );

  const selectedModelId = modelByProvider[selectedProvider] ?? getDefaultModelForProvider(selectedProvider);
  const selectedModelIndex = Math.max(
    0,
    modelOptions.findIndex((option) => option.value === selectedModelId),
  );
  const resolvedModelIndex = selectedModelIndex >= 0 ? selectedModelIndex : 0;

  const overlayWidth = Math.min(92, Math.max(62, Math.floor(renderer.width * 0.72)));
  const overlayHeight = Math.min(28, Math.max(18, Math.floor(renderer.height * 0.7)));
  const left = Math.max(0, Math.floor((renderer.width - overlayWidth) / 2));
  const top = Math.max(0, Math.floor((renderer.height - overlayHeight) / 2));

  const applySelection = () => {
    const model = modelOptions[resolvedModelIndex]?.value ?? getDefaultModelForProvider(selectedProvider);
    onApply({ provider: selectedProvider, model });
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      onClose();
      return;
    }

    if (key.name === "tab") {
      setFocusZone((prev) => (prev === "provider" ? "model" : "provider"));
      return;
    }

    if (focusZone === "provider") {
      if (key.name === "return" || key.name === "enter") {
        setFocusZone("model");
      }
      return;
    }

    if (key.name === "left") {
      setFocusZone("provider");
      return;
    }
  });

  return (
    <box
      position="absolute"
      top={top}
      left={left}
      width={overlayWidth}
      height={overlayHeight}
      flexDirection="column"
      border
      borderColor="cyan"
      backgroundColor="black"
      shouldFill
      padding={1}
      zIndex={100}
    >
      <text content={`Provider / Model (${agentId})`} fg="cyan" bg="black" bold />
      <text content="Applies to the current agent. Enter confirms, Tab switches panels." fg="gray" bg="black" />

      <box height={5} width="100%" marginTop={1} border borderColor={focusZone === "provider" ? "cyan" : "gray"}>
        <tab-select
          width="100%"
          height="100%"
          options={providerOptions}
          selectedIndex={providerIndex}
          focused={focusZone === "provider"}
          wrapSelection
          showDescription
          showUnderline
          selectedBackgroundColor="cyan"
          selectedTextColor="black"
          onChange={(index: number) => {
            if (typeof index === "number") {
              setProviderIndex(index);
            }
          }}
          onSelect={() => {
            setFocusZone("model");
          }}
        />
      </box>

      <box flexGrow={1} width="100%" marginTop={1} border borderColor={focusZone === "model" ? "cyan" : "gray"}>
        <select
          width="100%"
          height="100%"
          options={modelOptions}
          selectedIndex={resolvedModelIndex}
          focused={focusZone === "model"}
          wrapSelection
          showDescription
          showScrollIndicator
          selectedBackgroundColor="cyan"
          selectedTextColor="black"
          selectedDescriptionColor="black"
          onChange={(_: number, option: { value?: unknown } | null) => {
            const nextModel = typeof option?.value === "string" ? option.value : undefined;
            if (!nextModel) return;
            setModelByProvider((prev) => ({
              ...prev,
              [selectedProvider]: nextModel,
            }));
          }}
          onSelect={() => {
            applySelection();
          }}
        />
      </box>

      <box height={3} width="100%" marginTop={1} flexDirection="column" backgroundColor="black">
        <text
          content={`Next runtime: ${selectedProvider}/${modelOptions[resolvedModelIndex]?.value ?? "-"}`}
          fg="yellow"
        />
        <text content="h/l or ←/→: provider  j/k or ↑/↓: model  Enter: apply  Esc: close" fg="gray" bg="black" />
      </box>
    </box>
  );
}
