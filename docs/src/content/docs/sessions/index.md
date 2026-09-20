---
title: Working with sessions
description: Prompt, steer, inspect, and recover durable Oh My Pi conversations.
---

A session is the durable conversation you work in. The browser exposes normal prompting, streaming responses, tool activity, queued follow-ups, model controls, history actions, and recovery controls.

## Begin with prompting

[Prompting the agent](/sessions/prompting/) covers sending multiline prompts, steering a streaming turn, queueing follow-ups, using composer completion, attaching images, and responding to agent requests.

## In this section

- [Prompting the agent](/sessions/prompting/) covers the composer, autocomplete, prompt history, and agent dialogs.
- [Steering, follow-ups, and queues](/sessions/queues/) explains how messages reach a running turn and how the queue bar behaves.
- [Tool calls, diffs, and images](/sessions/tools-diffs-images/) covers the card views, inline diffs, and image handling.
- [Models, roles, and thinking levels](/sessions/models-roles-thinking/) explains model selection and where each choice is persisted.
- [Goals and plan mode](/sessions/goals-and-plan/) documents long-running goals and the read-only planning mode.
- [Manage session history](/sessions/history/) compares new, resume, rename, branch, fork, fresh, retry, compact, handoff, and drop.
- [Compaction, retry, and recovery](/sessions/recovery/) covers stopping a stuck turn and recovering after a failure or disconnect.
- [Export and download sessions](/sessions/export/) covers HTML export, transcript dumps, and copy actions.

## Persistence and control

The active session belongs to its transcript, not to the lifetime of its session daemon. Stopping or sleeping a session daemon does not discard the conversation. When you return, the fleet can wake the process and resume the recorded session.

Use [Start your first session](/getting-started/start-first-session/) for the initial workflow and [Troubleshooting](/operations/troubleshooting/) when a session cannot become ready or reconnect.
