---
title: Export and download sessions
description: Export a session to a self-contained HTML file, dump the transcript and the last LLM request, copy message content, and understand where the resulting files are written and how the session daemon's download jail is shaped.
---

A session lives in a JSONL transcript, but you often want it somewhere else: a shareable file, a text dump for review, or an exact copy of what the model was sent. The browser offers all three. The export and dump actions write their files on the machine that runs the attached session daemon.

## Export to HTML

`/export` writes a self-contained HTML file on the machine that runs the attached session daemon:

- The file is named `omp-session-<session-id>.html` and lands in the session daemon's working directory.
- It contains the full conversation rendered as HTML, including tool activity.
- Subagent transcripts found next to the session file are embedded by default.
- The default look is the omp-web palette. `/export --themes` bundles your configured dark and light terminal themes instead, so the file matches the terminal agent's appearance.

When the export completes, the stream shows an `Exported session HTML` notice naming the file's path on that host. An in-memory session that has no session file cannot be exported.

## Dump the transcript and the LLM request

`/dump` produces two artifacts:

- `transcript.txt` downloads directly in the browser. It is a plain-text rendering of the session built from the session's own dump format: a prelude with the system prompt, model and thinking configuration, and the tool inventory, followed by the message history with headings for user turns, assistant turns, thinking, tool calls with their arguments, tool results, and execution summaries.
- An LLM request dump is written to the system temp directory on the session daemon's host, and the stream shows an `LLM request dump` notice naming its path. This is the JSON that would be sent to the provider for the session's messages, and it is useful when you need to reproduce exactly what the model saw. When nothing can be dumped yet, the notice reads `No LLM request dump available yet.`

If the transcript has no messages, the stream reports `Transcript is empty, nothing to download.`, and only the LLM request dump part is attempted.

## Copy individual content

The export and dump actions are not the only way content leaves a session:

- Assistant messages have a `copy` button that copies the message's markdown. The label flips to `copied` briefly, or to `failed` when the clipboard is unavailable.
- User messages have the same button for their text.
- Search tool results copy a path to the clipboard when you click its `path:line` prefix.

## The download route and its jail

The session daemon exposes one download route, `GET /download?path=...`, and it is deliberately narrow:

- A relative path resolves against the session daemon's working directory; an absolute path is used as given.
- The resolved file must live inside the system temp directory, the session daemon's working directory, or the directory of a live session file. Both sides are canonicalized, so symlinks cannot escape the allowed roots.
- Outside those roots the route answers `403 Forbidden`; a missing file answers `404 Not Found`.
- Off-loopback session daemons require the bearer token on this route too, supplied as a `?token=` query parameter or an `Authorization` header. A wrong credential is `401 Unauthorized`. See [Security model](/operations/security/).

This route is the only file-egress path in the session daemon; the agent's file listing never escapes its working directory. The fleet does not proxy it, and the browser's origin is the fleet, so a `/download` link never resolves from the browser. The export and dump notices name the file's path on the session daemon's host instead.

## Retrieve an exported file

Retrieve the file on the machine that runs the session daemon:

- The HTML export lands in that session daemon's working directory as `omp-session-<session-id>.html`.
- The LLM request dump lands in the system temp directory on that host.
- For a remote host, read or copy the file there, for example over SSH.

The `transcript.txt` download from `/dump` is the exception: it is built in the browser, so it saves straight to your machine.

Downloads are the wrong tool for inspecting history across many sessions; use the [transcript browser](/analysis/transcripts/) and [session analytics](/analysis/analytics/) instead.

## Failure cases

- An export of a session with no session file fails, because there is nothing on disk to render from.
- The notice appears without a path when the export returned none.
- `403` means the file is outside the allowed roots. `404` means it is gone or was never written.
- `401` means the session daemon is bound off-loopback and the request carried no valid token.
- A dump taken before the session has sent anything to a provider has no LLM request to show.

## Related

- [Manage session history](/sessions/history/)
- [Session persistence](/concepts/session-persistence/)
- [Files and directories](/reference/files/)
- [Transcripts](/analysis/transcripts/)
- [Security model](/operations/security/)
- [Slash commands](/reference/slash-commands/)
