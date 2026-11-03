"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Avatar, Tag, StatusDot } from "./ui";
import { type Event, relTime } from "@/features/console/types";

export function VirtualEventList({ events, showProject = false }: { events: Event[]; showProject?: boolean }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 6,
  });

  if (events.length === 0) {
    return <div className="empty">No events yet.</div>;
  }

  return (
    <div ref={parentRef} style={{ height: 420, overflow: "auto" }}>
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const event = events[virtualRow.index];
          if (!event) return null;
          return (
            <div
              key={event.id}
              style={{
                left: 0,
                position: "absolute",
                top: 0,
                transform: `translateY(${virtualRow.start}px)`,
                width: "100%",
              }}
            >
              <EventRow event={event} showProject={showProject} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventRow({ event, showProject }: { event: Event; showProject: boolean }) {
  return (
    <div className="row" style={{ alignItems: "flex-start", borderBottom: "1px solid var(--line)", gap: 14, padding: "12px 18px" }}>
      <StatusDot status={eventTone(event.type)} />
      <div className="col gap-4 grow truncate">
        <div className="row gap-8 t-small">
          <Avatar color={event.color} mark={event.actorMark} />
          <span>{event.actor}</span>
          <span className="t-mute">{eventVerb(event.type)}</span>
          <span className="t-mono truncate">{event.target}</span>
          {showProject && event.project ? <span className="t-mute">/ {event.project}</span> : null}
        </div>
        {event.note ? <div className="t-mono t-tiny t-mute">{event.note}</div> : null}
      </div>
      <div className="t-mono t-tiny t-mute" style={{ flex: "none" }}>
        {relTime(event.t)}
      </div>
    </div>
  );
}

function eventTone(type: string) {
  if (type.endsWith("succeeded") || type.endsWith("created") || type.endsWith("added") || type.endsWith("promoted")) {
    return "ok";
  }
  if (type.endsWith("failed") || type.endsWith("rolled_back")) return "err";
  if (type.endsWith("warning") || type.endsWith("started")) return "warn";
  return "info";
}

function eventVerb(type: string) {
  switch (type) {
    case "version.created":
      return "created";
    case "visibility.changed":
      return "changed visibility";
    case "domain.added":
      return "added domain";
    case "token.created":
      return "created token";
    case "quota.warning":
      return "raised quota warning";
    case "billing.changed":
      return "changed billing";
    case "project.created":
      return "created project";
    default:
      return type;
  }
}
