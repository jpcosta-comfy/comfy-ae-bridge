# Comfy AE Bridge

A chat agent drives Adobe After Effects. Comfy-generated clips land in an editable template, and the same project can be brand-fixed (swap a pill, move the logo, render before and after) without a motion designer writing ExtendScript by hand.

The default local transport does **not** install anything inside After Effects. Claude Code starts a stdio server, and that server sends each script straight to AE.

```
Claude Code  --stdio-->  node src/stdio.js  --osascript DoScriptFile-->  After Effects
```

Owner: JP Costa. This is a prototype for Comfy's product team and other motion people who will install it and try the two prompts below.

## Install

Node 20 or newer. After Effects 2020–2026 on the Mac. One plugin: official Comfy Cloud generation and After Effects. No panel. No second connector. No relay.

```bash
claude plugin marketplace add jpcosta-comfy/comfy-ae-bridge
claude plugin install comfy-ae-bridge@comfy-ae-bridge
```

Claude Code copies the plugin into its cache and installs the Node dependencies from `package-lock.json` automatically. You do not need to clone the repo or run `npm install` for this path.

Claude asks for the Comfy Cloud API key (`platform.comfy.org/profile/api-keys`, it starts with `comfyui-`). The plugin stores it as `COMFY_CLOUD_API_KEY` for `node src/stdio.js`. The key is not written into the repo and is never logged.

If plugin install is unavailable, clone the repo, install dependencies, and register the same server by hand:

```bash
git clone https://github.com/jpcosta-comfy/comfy-ae-bridge.git
cd comfy-ae-bridge && npm install
claude mcp add --scope user -e COMFY_CLOUD_API_KEY=YOUR_KEY --transport stdio comfy-ae-bridge -- node "$(pwd)/src/stdio.js"
```

From a local checkout you are developing (`<REPO>`), install dependencies yourself, then add the marketplace from that folder. A local-directory marketplace does not run `npm install` for you:

```bash
cd <REPO> && npm install
claude plugin marketplace add <REPO>
claude plugin install comfy-ae-bridge@comfy-ae-bridge
```

Quit and reopen Claude Code. Do not also add `https://cloud.comfy.org/mcp` as its own connector. This server already talks to it.

Two one-time prompts:

1. **macOS Automation.** The first After Effects call asks whether Claude Code may control After Effects. Allow it. If you miss it, or a call returns `stage: "connect"` with `-1743`, open **System Settings → Privacy & Security → Automation** and enable Claude Code under After Effects.
2. **After Effects.** **Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network.**

`client_os` sent to Cloud is `darwin` on a Mac, `win32` on Windows, `linux` otherwise. `macos` is rewritten to `darwin`.

That one server generates on Comfy Cloud and places the files in After Effects. If the key is missing, generation returns the install line above.

Generation talks to the official Comfy Cloud MCP at `https://cloud.comfy.org/mcp`, sending the key as the `X-API-Key` header. Interactive clients can use OAuth instead; this process has no browser, so the API key is the auth that works. Official tools show up here with a `comfy_` prefix (`comfy_search_templates`, `comfy_run_template`, `comfy_partner_generate`, `comfy_wait_for_job`, `comfy_get_output`, and the rest of that server's list). Paid runs are one at a time. A paid run shows a confirmation dialog to the user. `COMFY_GEN_BACKEND=mcp` requires that MCP. `rest` forces the built-in HTTP client. `auto` (the default) uses the official MCP and falls back to REST only if it cannot be reached.

`COMFY_AE_OUTPUT_DIR` sets where downloads land. Otherwise `ae_generate_and_place` saves them in `comfy-generations` next to the open `.aep`.

Generation uses `https://cloud.comfy.org`: `GET /api/workflow_templates`, `GET /api/models` and `/api/models/{folder}`, `POST /api/v2/assets`, `POST /api/v2/jobs`, `GET /api/v2/jobs/{id}`, `https://cloud.comfy.org/api/v2/assets/{id}/content` for downloads, and `GET /api/billing/usage/timeseries` for credit balance when the API returns it. Downloads follow redirects by hand and keep the API key only on `cloud.comfy.org`. If the template list is empty, `comfy_generate` with no template runs built-in `z-image-turbo` (Z-Image Turbo bf16, Qwen 3 4B, VAE ae, 8 steps). Workflow JSON must be API format, not the UI `nodes`/`links` export. `variants` default to one at a time (`concurrency` 1). Credit fields come back as `raw` API numbers plus `labeled` USD.

The server looks for Adobe After Effects 2026, then 2025, then older. Override the AppleScript name with `AE_APP_NAME` (for example `Adobe After Effects 2025`) if the app lives somewhere else.

The AppleScript uses `launch` and `DoScriptFile`. It does not send `activate`. Each script is wrapped with `beginSuppressDialogs` / `endSuppressDialogs(false)`. `alert`, `confirm`, `prompt`, and the file pickers throw, and those errors come back as `stage: "eval"`.

`COMFY_AE_TRANSPORT` selects the path:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Direct when an AE install is found. Otherwise the CEP panel socket. |
| `direct` | Always osascript / AfterFX. A missing install returns `stage: "connect"`. |
| `panel` | Only the CEP panel on `127.0.0.1:9227`. |

### Windows (implemented, untested)

The server looks for `AfterFX.com` and then `AfterFX.exe` under `Program Files\Adobe\Adobe After Effects 20xx\Support Files` and runs `AfterFX -r <script.jsx>`. Set `AE_APP_PATH` to the exe if detection misses. This path has not been run against a Windows After Effects. The same dialog-suppression wrapper is injected.

### Optional panel

The CEP panel is only a status light. Install it from `Comfy-AE-Bridge-mac.zip` (`install.command`) if you want **Window > Extensions > Comfy AE Bridge**. In the panel, **Local daemon** talks to the stdio socket. Calls still go direct unless `COMFY_AE_TRANSPORT=panel`.

### Optional relay

A hosted relay plus the panel is how a cloud Claude connector reaches a Mac it cannot see. That config is an example, not loaded automatically: `examples/relay.mcp.json`. Do not put it back at the repo root. Claude Code treats a root `.mcp.json` as a project server and it collides with the user-scoped stdio server.

The skill in `skills/comfy-ae-bridge/SKILL.md` covers the two jobs below. `claude --plugin-dir <REPO>` loads that skill and does not register an MCP server.

## Two prompts to try

**Batch launch variations**

> I have the AE template `Launch_Master` open. The placeholder layer is `MEDIA`. Generate 3 product-hero clips, about 4 seconds each, different camera moves, no logos and no burned-in text. Drop each clip into the template, one variant per clip, and queue 16:9, 9:16, and 1:1. Do not start the render until I say so. Tell me the output paths.

**Brand fix**

> Survey the open project. The pill on the left should be the precomp `Pill_New`, and the logo layer `LOGO` should sit 64 pixels from the top-right. Swap the wrong pill in place, move the logo, and render a before and an after of the main comp. Do not change anything else.

Use whatever comp, layer, and precomp names are actually in the project if those are different. The agent is supposed to survey first and say which layers it will touch.

## What the agent can do

| Tool | Job |
| --- | --- |
| `ae_exec` | Run ES3 ExtendScript. Last expression comes back as `result`. |
| `ae_import` | Import a file. |
| `ae_replace_source` | Point an existing footage item at a new file. |
| `ae_relink_missing` | Relink missing footage by file name from a folder. |
| `ae_layer_swap` | New file, or an existing precomp (`component`), onto a layer. |
| `ae_render_queue_add` | Queue a comp. Does not render. |
| `ae_render_start` | Render the queue, or only the indices you pass. Blocks until AE finishes. |
| `ae_batch` | Several snippets in one round trip. |
| `ae_survey` | Comps, layers, text, footage, missing files. |
| `ae_place_variants` | One template, N clips (paths or URLs), queue 16:9 / 9:16 / 1:1 (and 4:5). |
| `ae_move_to_corner` | Move a layer to TL, TR, BL, or BR. |
| `ae_status` | `direct` or `panel`, and whether that path can reach AE. |
| `comfy_list_templates` | Templates on Comfy Cloud. This server calls the API. |
| `comfy_list_models` | Model folders and files on Comfy Cloud. |
| `comfy_generate` | Upload inputs, run a template or API-format workflow, poll, download. |
| `comfy_job_status` | Status and progress for a Comfy Cloud job. |
| `comfy_download` | Download a finished job's outputs. |
| `ae_generate_and_place` | Generate, download, and place in the open AE project. |

Failures use a stage, not a vague error: `connect`, `eval`, `timeout`, `parse`, or `dialog`. A modal dialog in AE fails the in-flight idea of "wait for the timeout": the panel's heartbeat stops, and the next call returns `dialog` in a few seconds.

Results bigger than 64KB are written to a temp file inside AE and read back by the panel, so the evalScript return channel does not have to carry them.

## Troubleshooting

**The panel never appears.** PlayerDebugMode is off, or AE was not restarted after install. Run `install.command` again. Unsigned extensions do not load without that flag. Confirm the folder exists: `~/Library/Application Support/Adobe/CEP/extensions/com.comfy.aemcp`.

**The dot stays red.** The relay field must be the websocket URL (`ws://` or `wss://…/ws`), not the connector URL. The relay process has to be up. A local test uses `ws://127.0.0.1:8787/ws` and `npm run relay` on that Mac.

**Claude says the connector failed, or tools return `connect`.** Claude.ai runs in the cloud and cannot see `127.0.0.1` on your Mac. The relay has to be a public `https` host, and the panel has to be connected to it (green dot) before you paste the URL. After a relay restart the panel reconnects on its own; if a call happens in that gap you get `connect` once.

**`dialog`.** This is the panel transport. Close the alert in After Effects. On the direct transport, script dialogs are suppressed and returned as `stage: "eval"` instead.

**`connect` and `-1743`.** macOS Automation was denied. System Settings → Privacy & Security → Automation → allow Claude Code or Terminal to control After Effects.

**Import or download failed.** Turn on *Allow Scripts to Write Files and Access Network*. URLs are fetched with `curl` on the AE machine.

**`eval` mentioning a missing layer or comp.** Names are case-sensitive and come from the project. Run a survey (the agent should) and use those strings.

**A second computer grabbed my code.** It cannot, while this panel is connected. The relay keeps one live panel per code. *New code* in the panel invalidates the URL you already pasted.

**Port already in use (developers).** Another stdio server is on 9227, or another relay is on 8787. Stop it, or set `AE_BRIDGE_PORT` / `PORT`.

## Deploy the relay

The relay is a normal Node process with a websocket. Serverless hosts that freeze between requests will drop the panel. Fly and Railway fit. Vercel does not.

Nothing in this prototype is deployed. There are no credentials in the repo. From a machine that is already logged in:

```bash
# Fly. Edit the app name in fly.toml first if "comfy-ae-bridge" is taken.
fly launch --copy-config --no-deploy
fly deploy

# or Railway, from the repo root (Procfile is the start command)
railway up

# or any host that can run a container
docker build -t comfy-ae-bridge .
docker run --rm -p 8787:8787 comfy-ae-bridge
```

Then set the panel's relay field to `wss://<the host>/ws` and copy the connector URL. One machine is enough: pairing state and MCP sessions are in memory, so do not run two replicas.

Check it with `curl https://<the host>/health`.

Locally, for a test on the same Mac as AE and Claude Code:

```bash
npm install
npm run relay
```

The panel's default relay is `ws://127.0.0.1:8787/ws`.

## Developers

The install line above is the whole local setup. Node 20 or newer. No panel.

To force the panel socket instead:

```bash
COMFY_AE_TRANSPORT=panel node src/stdio.js
```

In the panel, click **Local daemon**. It dials `ws://127.0.0.1:9227`.

```bash
npm test
bash scripts/pack-mac-installer.sh
```

`npm test` does not need After Effects. A fake panel speaks the same websocket the CEP panel speaks. The relay test is a streamable-HTTP MCP client (initialize, then `tools/call`) through the relay to that fake panel.

On a Mac, `installer/macos/build-pkg.sh` writes `dist/ComfyAEBridge-unsigned.pkg`. `pkgbuild` does not exist on Linux, so CI produces the zip instead of the pkg.

### Signing, which this prototype does not do

The panel is an unsigned CEP extension. `install.command` sets `PlayerDebugMode` for CSXS 11 (AE 2025) and CSXS 12 (AE 2026) so AE will load it. That is a developer switch, not a shippable install.

Before anyone outside the team installs this:

- Sign the extension as a ZXP with an Adobe certificate (`ZXPSignCmd -sign`), and stop relying on PlayerDebugMode. The bundle id is `org.comfy.aemcp`.
- Sign the `.pkg` with a Developer ID Installer certificate and notarize it, or testers will have to right-click through Gatekeeper. `build-pkg.sh` prints the `productsign` invocation.
- Serve the relay over TLS. Treat the connector URL as a password. *New code* rotates it.

### Layout

- `src/relay.js` — streamable HTTP MCP and the panel websocket.
- `src/direct.js` — panel-less macOS osascript and Windows AfterFX transport.
- `src/stdio.js` — stdio MCP. Direct by default, panel socket on `127.0.0.1:9227` as fallback.
- `src/tools.js`, `src/jsxlib.js` — tool definitions and the ES3 they send.
- `src/harness.js`, `src/panel-link.js` — eval harness, 64KB spill, dialog watchdog.
- `panel/` — CEP 12 panel.
- `skills/comfy-ae-bridge/SKILL.md` — the two jobs, for the agent.
- `installer/` — macOS double-click install, unsigned pkg script, Windows script.

The ExtendScript harness, the error stages, and the named import / replace / relink / render / layer-swap / batch tools follow Comfy's internal AE Bridge. This repo does not import that project. The gap that bridge left open was the local daemon. The relay is the piece that closes it.
