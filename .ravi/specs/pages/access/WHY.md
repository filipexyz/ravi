---
id: pages/access
title: "Why agents share, invite and ask through the CLI"
kind: capability
domain: pages
capability: access
status: active
---

# Why agents share, invite and ask through the CLI

## Problem

To show a private Page to one person, agents made the route public or put a
password on it. Bringing someone into the organization went through the
admin endpoint. A denied Page was a dead end in chat.

## Design

- Console already holds the access model (grants, invites, requests), so the
  CLI adds none. It only says who wrote the turn.
- The operator's `ravi login` must never act for someone else. The same turn
  classifier as connectors decides: the operator's own turns act as the
  operator; another person's turn names that person, and Console acts for
  them through their `ravi link`, requiring both them and the operator to be
  allowed. A turn nobody can be named for is refused here.
- Sharing, inviting and asking reach people outside the operator's control
  (a new viewer, a new member, another organization's admins), so they are
  braked. Removing access only narrows it and applies at once.
- The approval link of a request is safe to forward because opening it
  changes nothing and Console shows it only to the page's managers and the
  requester. Saying so lets the agent hand it to whoever knows the managers.
