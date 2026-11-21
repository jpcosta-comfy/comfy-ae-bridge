---
name: comfy-ae-bridge
description: Generate with Comfy Cloud and place or animate the result in Adobe After Effects, using only the comfy-ae-bridge server. Use when the user asks in plain words to make a still or clip and put it in an AE comp, fix a layout, or render.
---

# Comfy AE Bridge

This plugin is the only server. Its `comfy_*` tools are the official Comfy Cloud MCP (`https://cloud.comfy.org/mcp`). Its `ae_*` tools drive After Effects. Do not add a Comfy Cloud, comfy-mcp, or comfy-cloud connector.

Talk to the user in plain words. Do the tool work yourself. At the end, name the tools you called and any cost the Cloud tools reported.

## Before anything else

1. Call `ae_status`. Read `projectInfo`: `path` when the project is saved, `name` plus `saved: false` when it is open but unsaved, `numItems`, and `activeComp` (`name`, `width`, `height`).
2. If `connected` is false or `stage` is `connect`, stop. The usual cause is the macOS Automation prompt (System Settings, Privacy & Security, Automation, allow Claude Code to control After Effects) or the AE preference **Allow Scripts to Write Files and Access Network** being off.
3. If the path is not the project the user means, stop and say which file is open.

## Discover, then generate

1. `comfy_search_templates` for what they described. Do not invent template names.
2. `comfy_get_template_schema` on the chosen name before `comfy_run_template`.
3. `client_os` is `darwin`, `win32`, or `linux`. This machine's value is `process.platform`. Never send `macos`, `mac`, or `osx`. The bridge rewrites those to `darwin`, but you should send `darwin` yourself.
4. Generation width and height must be multiples of 16. If the target comp is 1920×1080, generate at 1920×1088, then fit and center into the comp. The bridge rounds up when you pass the comp size to `ae_generate_and_place`.
5. Paid tools (`comfy_run_template`, `comfy_submit_workflow`, `comfy_partner_generate`, and the other `comfy_generate_*` tools) run one at a time. Do not fire several in parallel. A paid run shows a confirmation dialog to the user.
6. `ae_generate_and_place` is the one-shot: official `run_template` or `submit_workflow`, then `wait_for_output` or `wait_for_job` and `get_output`. Download the URL or `/api/s/...` shortlink that tool returns. Do not assume `/api/v2/assets/{id}/content` when a shortlink is present.
7. Pass `output_dir` as a folder the user chose. Never write renders or downloads onto the system disk by default (`/` or a full volume). If they did not name a folder, ask, or use a folder next to the `.aep` only when `projectInfo.saved` is true.

## Place, animate, render

1. `ae_import` or `ae_generate_and_place` writes into the open project. The result's `project` and `projectInfo.path` must match the file from `ae_status`. If they differ, stop.
2. Fit the still or clip inside the comp and center it. The placeholder layer is `MEDIA` unless the survey shows another name.
3. Animate only what they asked (swap, move a logo to TL/TR/BL/BR, change a label). `ae_survey` first when the comp is someone else's.
4. Render with `ae_render_queue_add` then `ae_render_start` into the folder they named. Report each output path.
5. Close with the tools used, the project path, the output paths, and cost or credits if a Cloud tool returned them.

## When a call fails

- `stage: "connect"` — AE is not reachable, or Automation permission was denied (`-1743`).
- `stage: "eval"` — the script threw. The message includes the line. No dialog should be on screen.
- `stage: "dialog"` — only the optional CEP panel transport. Ask them to close the dialog.
- A Cloud tool error that names `client_os` — resend with `darwin`, `win32`, or `linux`.
