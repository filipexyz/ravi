// The card the runtime draws when no widget applies: an `article` named by
// its title (the `card-title` column or the first text column), an optional
// cover image, and the given fields with visible labels, each by type.

import type { RenderContext, RenderRecord, VNode } from "../types";
import { renderField } from "./fields";
import { formatValue, rawValueText } from "./format";
import { messages } from "./messages";
import { h, safeUrl, spaced } from "./vnode";

/** Most fields a default card shows; the runtime passes `card-fields` or the next 4 projected columns. */
export const DEFAULT_CARD_MAX_FIELDS = 8;

export function renderDefaultCard(
  input: { record: RenderRecord; titleKey: string | null; fieldKeys: string[]; coverKey: string | null },
  ctx: RenderContext,
): VNode[] {
  const { record } = input;
  const msgs = messages(ctx.locale);
  const titleId = `${ctx.idPrefix}-title`;
  const titleColumn = input.titleKey ? ctx.columns[input.titleKey] : undefined;
  const titleValue = input.titleKey ? record.values[input.titleKey] : undefined;
  const titleText = (titleColumn ? formatValue(titleColumn, titleValue, ctx) : "").trim() || msgs.untitled;
  const level = Math.min(6, Math.max(1, Number.isInteger(ctx.headingLevel) ? ctx.headingLevel : 2));

  const coverColumn = input.coverKey ? ctx.columns[input.coverKey] : undefined;
  const coverUrl = coverColumn && input.coverKey ? safeUrl(record.values[input.coverKey], ["https", "http"]) : null;

  const fields = input.fieldKeys
    .filter((key) => key !== input.titleKey && key !== input.coverKey && ctx.columns[key])
    .slice(0, DEFAULT_CARD_MAX_FIELDS)
    .map((key, index) =>
      renderField({ key, column: ctx.columns[key]!, value: record.values[key], label: "visible", editable: true, uid: `c${index}` }, ctx),
    );

  const children: VNode[] = [];
  if (coverUrl) children.push(h("img", { class: "ravi-image ravi-cover", src: coverUrl, alt: "" }));
  children.push(
    h(
      `h${level}`,
      {
        class: "ravi-title",
        id: titleId,
        "data-ravi-field": titleColumn ? input.titleKey : null,
        "data-ravi-value": titleColumn ? rawValueText(titleColumn, titleValue) : null,
      },
      titleText,
    ),
  );
  if (fields.length) children.push(h("div", { class: "ravi-card-fields" }, spaced(fields)));

  return [h("article", { class: "ravi-card ravi-default-card", "aria-labelledby": titleId, "data-ravi-row": record.id ?? "" }, spaced(children))];
}
