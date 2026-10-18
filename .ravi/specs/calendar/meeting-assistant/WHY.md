---
id: calendar/meeting-assistant
title: Meeting Assistant Decisions
kind: why
domain: calendar
capability: meeting-assistant
status: draft
normative: false
owners:
  - ravi-dev
---

# Meeting Assistant Decisions

## Why The Console Decides Recordings

Several members of one organization can have the same meeting in their
calendars. Only the Console sees all of them, so only the Console can send one
bot per meeting, apply the organization rule for automatic recording and the
external-attendee rule. The local side passes on one operator's choice.

## Why Events Are Read Live

The calendar is the operator's private data. A local copy in `ravi.db` would be
readable by any turn that reaches the local calendar tables, including turns
from other people. Reading the Console on the operator's own turns keeps the
data where the Console's authorization applies.

## Why Routines Are One-Shot Cron Jobs

The cron runner already owns scheduling, delivery barriers and the operator
principal. A job per reminder shows up in `ravi cron list`, can be removed by
the operator, and needs no new long-running loop beyond the planner.

## Why Routine Prompts Carry Only Ids

Titles, attendees and descriptions are written by whoever sent the invite. A
prompt that embedded them would let any invite place instructions in the
operator's agent turn. The agent reads the event through `ravi agenda show` and
the skill tells it to treat that content as data.

## Why Marks Instead Of Job State

A job deletes itself after it runs, and the operator may delete one by hand.
A mark per reminder key remembers that the reminder was already scheduled, so
neither case schedules it again.
