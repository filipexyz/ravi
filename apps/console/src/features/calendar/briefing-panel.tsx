"use client";

import { Panel } from "@/ui/layout";
import { RelativeTime } from "@/ui/time";

import { useMeetingBriefing } from "./api";

/** The person's own briefing for this call, prepared by their agent. Hidden when there is none. */
export function MeetingBriefingPanel({ meetingId }: { meetingId: string }) {
  const briefing = useMeetingBriefing(meetingId);
  if (!briefing.data) return null;
  return (
    <Panel as="section" className="mb-6 p-5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">Your briefing</h2>
        {briefing.data.updatedAt ? (
          <span className="text-xs text-ink-3">
            Prepared <RelativeTime value={briefing.data.updatedAt} />. Only you see it.
          </span>
        ) : null}
      </div>
      <BriefingText markdown={briefing.data.markdown} />
    </Panel>
  );
}

/** Headings in bold, everything else as written: enough for the short Markdown an agent writes here. */
function BriefingText({ markdown }: { markdown: string }) {
  const blocks = markdown.split(/\n{2,}/);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink-2">
      {blocks.map((block, index) => {
        const heading = block.match(/^#{1,6}\s+(.+)$/m);
        if (heading && block.trim().split("\n").length === 1) {
          return (
            <h3 className="pt-1 text-[13px] font-semibold text-ink" key={index}>
              {heading[1]}
            </h3>
          );
        }
        const [first, ...rest] = block.split("\n");
        const firstHeading = first?.match(/^#{1,6}\s+(.+)$/);
        return (
          <div key={index}>
            {firstHeading ? <h3 className="pb-1 text-[13px] font-semibold text-ink">{firstHeading[1]}</h3> : null}
            <p className="whitespace-pre-wrap">{(firstHeading ? rest : [first, ...rest]).join("\n")}</p>
          </div>
        );
      })}
    </div>
  );
}
