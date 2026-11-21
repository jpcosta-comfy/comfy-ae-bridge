import { z } from "zod";
import { jsxWithArgs, placeVariantsJsx, surveyJsx, moveToCornerJsx } from "./jsxlib.js";
import { DEFAULT_TIMEOUT_MS } from "./panel-link.js";
import { registerGeneration } from "./cloud-tools.js";

const itemSpec = z.union([z.string(), z.number().int()])
  .describe("Project item name (string) or item id (number)");

function asToolResult(res) {
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    isError: !res.ok,
  };
}

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {{ exec: Function, status: Function }} bridge
 */
export async function registerTools(server, bridge, options = {}) {
  const exec = (jsx, timeoutMs) => bridge.exec(jsx, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const wrap = async (jsx, timeoutMs) => asToolResult(await exec(jsx, timeoutMs));

  server.registerTool(
    "ae_exec",
    {
      title: "Execute ExtendScript in After Effects",
      description:
        "Run ExtendScript (ES3) inside the open After Effects project. The value of the script's last expression is returned as result. " +
        "Every response is { ok, result | stage+error, project }. Stages: connect (panel closed), eval (jsx threw), timeout, parse, dialog (modal dialog). " +
        "ES3 only: no let/const, arrows, template strings, or Array.forEach. Check project on every call so you are in the file you think you are.",
      inputSchema: {
        jsx: z.string().describe("ExtendScript source. Last expression is the result."),
        timeout_ms: z.number().int().positive().optional()
          .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`),
      },
    },
    async ({ jsx, timeout_ms }) => wrap(jsx, timeout_ms)
  );

  server.registerTool(
    "ae_status",
    {
      title: "AE Bridge connection status",
      description: "Which transport is in use, and the open After Effects project: saved path or unsaved name, numItems, and the active comp. A saved project reports its .aep path even when the panel is not installed. Call this before generating or importing.",
      inputSchema: {},
    },
    async () => {
      const snap = bridge.inspectProject ? await bridge.inspectProject() : bridge.status();
      const info = snap.projectInfo;
      const project = info?.path
        || (info?.open ? `${info.name} (unsaved, ${info.numItems} items)` : null)
        || snap.project
        || "(no project open)";
      return asToolResult({
        ok: snap.stage !== "connect",
        result: snap,
        project,
        projectInfo: info || null,
      });
    }
  );

  server.registerTool(
    "ae_batch",
    {
      title: "Run several ExtendScript ops in one round-trip",
      description:
        "Execute an array of ExtendScript snippets inside a single eval and return one array of per-op results. One op throwing does not abort the others.",
      inputSchema: {
        ops: z.array(z.string()).describe("ES3 snippets. Each one's last expression is that op's result."),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    ({ ops, timeout_ms }) => wrap(jsxWithArgs({ ops }, `
  var results = [];
  for (var i = 0; i < ARGS.ops.length; i++) {
    try {
      var v = eval(ARGS.ops[i]);
      results.push({ ok: true, value: (v === undefined ? null : v) });
    } catch (e) {
      results.push({ ok: false, error: String(e), line: (e && e.line) || null });
    }
  }
  return results;`), timeout_ms)
  );

  server.registerTool(
    "ae_import",
    {
      title: "Import a file into the AE project",
      description: "Import a footage file into the open project. Returns the new item id and name.",
      inputSchema: {
        path: z.string().describe("Absolute path on the After Effects machine"),
        folder: z.string().optional().describe("Project folder name (created if missing)"),
      },
    },
    ({ path, folder }) => wrap(jsxWithArgs({ path, folder: folder || null }, `
  var f = new File(ARGS.path);
  if (!f.exists) throw new Error("file not found: " + ARGS.path);
  var item = app.project.importFile(new ImportOptions(f));
  if (ARGS.folder) {
    var target = __findFolder(ARGS.folder) || app.project.items.addFolder(ARGS.folder);
    item.parentFolder = target;
  }
  var brief = __itemBrief(item);
  brief.projectPath = (app.project && app.project.file) ? app.project.file.fsName : "";
  brief.projectSaved = !!(app.project && app.project.file);
  brief.numItems = app.project ? app.project.numItems : 0;
  return brief;`))
  );

  server.registerTool(
    "ae_replace_source",
    {
      title: "Replace a footage item's source file",
      description: "Point an existing footage item at a new file. Every comp using that item updates.",
      inputSchema: {
        item: itemSpec,
        path: z.string().describe("Absolute path to the replacement file"),
      },
    },
    ({ item, path }) => wrap(jsxWithArgs({ item, path }, `
  var it = __findItem(ARGS.item);
  if (!it) throw new Error("item not found: " + ARGS.item);
  if (!(it instanceof FootageItem)) throw new Error("not a footage item: " + it.name);
  var f = new File(ARGS.path);
  if (!f.exists) throw new Error("file not found: " + ARGS.path);
  var before = it.file ? it.file.fsName : null;
  it.replace(f);
  var out = __itemBrief(it);
  out.oldSource = before;
  out.newSource = it.file ? it.file.fsName : null;
  return out;`))
  );

  server.registerTool(
    "ae_relink_missing",
    {
      title: "Relink missing footage from a directory",
      description: "Find footage with missing sources and relink each by basename inside search_dir.",
      inputSchema: {
        search_dir: z.string().describe("Directory to search, matched by file name"),
        dry_run: z.boolean().optional().describe("Report matches without relinking"),
      },
    },
    ({ search_dir, dry_run }) => wrap(jsxWithArgs({ dir: search_dir, dry: !!dry_run }, `
  var relinked = [], missing = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (!(it instanceof FootageItem) || !it.footageMissing) continue;
    var base = it.file ? it.file.name : it.name;
    var cand = new File(ARGS.dir + "/" + base);
    if (cand.exists) {
      if (!ARGS.dry) it.replace(cand);
      var b = __itemBrief(it); b.relinkedTo = cand.fsName; relinked.push(b);
    } else {
      var m = __itemBrief(it); m.lookedFor = cand.fsName; missing.push(m);
    }
  }
  return { dryRun: ARGS.dry, relinked: relinked, stillMissing: missing };`))
  );

  server.registerTool(
    "ae_layer_swap",
    {
      title: "Swap a new render or a project component onto a layer",
      description:
        "Duplicate the target layer and point the duplicate at a new file (path) or an existing project item (component, a precomp or footage already in the project). " +
        "Keyframes, mattes, effects, masks, and parenting are inherited. The original is hidden, not deleted. " +
        "Pass duplicate:false to replace the layer's source in place instead of stacking a copy. " +
        "Use this to drop a generated clip onto a shot, or to swap a wrong pill for the correct template component.",
      inputSchema: {
        path: z.string().optional().describe("Absolute path to a new file. Omit when using component."),
        component: z.string().optional().describe("Name of a project item (precomp or footage) to use as the new source."),
        layer: z.string().optional().describe("Layer name. Omit to use the single selected layer."),
        comp: itemSpec.optional().describe("Comp name or id. Omit for the active comp."),
        hide_original: z.boolean().optional().describe("Hide the original layer (default true). Ignored when duplicate is false."),
        duplicate: z.boolean().optional().describe("Duplicate the layer before replacing (default true)."),
      },
    },
    ({ path, component, layer, comp, hide_original, duplicate }) => wrap(jsxWithArgs({
      path: path || null,
      component: component || null,
      layer: layer || null,
      comp: comp ?? null,
      hide: hide_original !== false,
      duplicate: duplicate !== false,
    }, `
  if (!ARGS.path && !ARGS.component) throw new Error("pass path or component");
  var c = __compOrActive(ARGS.comp);
  if (!c) throw new Error("no active comp");
  var target = null;
  if (ARGS.layer) {
    for (var i = 1; i <= c.numLayers; i++) if (c.layer(i).name === ARGS.layer) { target = c.layer(i); break; }
    if (!target) throw new Error("layer not found in " + c.name + ": " + ARGS.layer);
  } else {
    if (c.selectedLayers.length !== 1) throw new Error("select exactly one layer or pass layer");
    target = c.selectedLayers[0];
  }
  var item = null;
  if (ARGS.component) {
    item = __findItem(ARGS.component);
    if (!item) throw new Error("component not found: " + ARGS.component);
  } else {
    var f = new File(ARGS.path);
    if (!f.exists) throw new Error("file not found: " + ARGS.path);
    item = app.project.importFile(new ImportOptions(f));
    if (target.source && target.source.parentFolder) item.parentFolder = target.source.parentFolder;
  }
  app.beginUndoGroup("ae_layer_swap");
  try {
    var nl = target;
    if (ARGS.duplicate) {
      nl = target.duplicate();
      nl.moveBefore(target);
      if (ARGS.hide) target.enabled = false;
    }
    nl.replaceSource(item, false);
    nl.enabled = true;
    return {
      comp: c.name,
      newLayer: { index: nl.index, name: nl.name },
      original: { index: target.index, name: target.name, hidden: ARGS.duplicate && ARGS.hide },
      source: item.name
    };
  } finally {
    app.endUndoGroup();
  }`))
  );

  server.registerTool(
    "ae_render_queue_add",
    {
      title: "Add a comp to the render queue",
      description: "Queue a composition. Does not start rendering. Returns the queue index and output path.",
      inputSchema: {
        comp: itemSpec,
        output: z.string().describe("Absolute output file path"),
        rs_template: z.string().optional().describe("Render Settings template name"),
        om_template: z.string().optional().describe("Output Module template name"),
      },
    },
    ({ comp, output, rs_template, om_template }) => wrap(jsxWithArgs({
      comp, output, rs: rs_template || null, om: om_template || null,
    }, `
  var c = __findItem(ARGS.comp);
  if (!c || !(c instanceof CompItem)) throw new Error("comp not found: " + ARGS.comp);
  var rqi = app.project.renderQueue.items.add(c);
  if (ARGS.rs) rqi.applyTemplate(ARGS.rs);
  var om = rqi.outputModule(1);
  if (ARGS.om) om.applyTemplate(ARGS.om);
  om.file = new File(ARGS.output);
  return { comp: c.name, rqIndex: app.project.renderQueue.numItems, output: om.file.fsName, status: String(rqi.status) };`))
  );

  server.registerTool(
    "ae_render_start",
    {
      title: "Render the queue (blocking)",
      description:
        "Render queued items. Blocks until After Effects finishes. Set timeout_ms above the expected render time (default 10 minutes). " +
        "Pass rq_indices to render only those 1-based queue items.",
      inputSchema: {
        rq_indices: z.array(z.number().int().positive()).optional()
          .describe("1-based render queue indices. Omit to render the whole queue."),
        timeout_ms: z.number().int().positive().optional()
          .describe("Timeout in ms (default 600000)."),
      },
    },
    ({ rq_indices, timeout_ms }) => wrap(jsxWithArgs({ only: rq_indices || null }, `
  var rq = app.project.renderQueue;
  if (rq.numItems === 0) throw new Error("render queue is empty");
  var saved = null;
  if (ARGS.only) {
    var want = {};
    for (var w = 0; w < ARGS.only.length; w++) want[ARGS.only[w]] = true;
    saved = [];
    for (var i = 1; i <= rq.numItems; i++) {
      var rqi = rq.item(i);
      if (rqi.status !== RQItemStatus.QUEUED && rqi.status !== RQItemStatus.UNQUEUED) { saved.push(null); continue; }
      saved.push(rqi.render);
      rqi.render = !!want[i];
    }
  }
  try {
    rq.render();
  } finally {
    if (saved) {
      for (var j = 1; j <= rq.numItems; j++) {
        if (saved[j - 1] !== null && rq.item(j).status !== RQItemStatus.DONE) {
          try { rq.item(j).render = saved[j - 1]; } catch (e) {}
        }
      }
    }
  }
  var items = [];
  for (var k = 1; k <= rq.numItems; k++) {
    var it2 = rq.item(k);
    if (ARGS.only) {
      var keep = false;
      for (var m = 0; m < ARGS.only.length; m++) if (ARGS.only[m] === k) keep = true;
      if (!keep) continue;
    }
    items.push({
      index: k,
      comp: it2.comp ? it2.comp.name : null,
      done: it2.status === RQItemStatus.DONE,
      status: String(it2.status),
      output: (it2.numOutputModules > 0 && it2.outputModule(1).file) ? it2.outputModule(1).file.fsName : null
    });
  }
  return { items: items };`), timeout_ms ?? 600_000)
  );

  server.registerTool(
    "ae_survey",
    {
      title: "Survey comps, layers, text, and footage",
      description:
        "List the open project's compositions (size, duration, layers), each layer's kind, source, and text, and footage items with paths and missing flags. " +
        "Call this before a brand fix so you swap real layer names instead of guessing. Large projects are truncated at 200 comps and 80 layers each.",
      inputSchema: {},
    },
    () => wrap(surveyJsx())
  );

  server.registerTool(
    "ae_place_variants",
    {
      title: "Drop generated clips into a template and queue every aspect",
      description:
        "For each generated clip or still (local path on the AE machine, or an http(s) URL such as a Comfy Cloud output), duplicate the named template comp, " +
        "replace the placeholder layer's source, then build a delivery comp per aspect ratio (16:9 1920x1080, 9:16 1080x1920, 1:1 1080x1080, optional 4:5) and queue an mp4. " +
        "Returns queued[].output paths and rqIndex. Does not render unless start_render is true. " +
        "URLs are downloaded on the After Effects machine with curl, which requires Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network.",
      inputSchema: {
        template_comp: z.string().describe("Template composition name"),
        placeholder_layer: z.string().describe("Layer name inside the template whose source is replaced"),
        assets: z.array(z.object({
          path: z.string().optional().describe("Absolute path on the AE machine"),
          url: z.string().optional().describe("http(s) URL to download on the AE machine"),
          label: z.string().optional().describe("Short variant name used in comp and file names"),
        })).describe("One entry per generated clip or still"),
        aspects: z.array(z.enum(["16:9", "9:16", "1:1", "4:5"])).optional()
          .describe("Defaults to 16:9, 9:16, and 1:1"),
        output_dir: z.string().optional().describe("Folder for mp4s. Defaults to <project>/comfy-renders when the project is saved."),
        fit: z.enum(["cover", "contain"]).optional().describe("How the variant fills each aspect frame. Default cover."),
        rs_template: z.string().optional(),
        om_template: z.string().optional().describe("Output Module template. Default is whatever the render queue's first module already is."),
        start_render: z.boolean().optional().describe("Render immediately. Blocks until the queue finishes."),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      let jsx;
      try {
        jsx = placeVariantsJsx(args);
      } catch (e) {
        return asToolResult({ ok: false, stage: "eval", error: e.message, project: null });
      }
      return wrap(jsx, args.timeout_ms ?? (args.start_render ? 600_000 : DEFAULT_TIMEOUT_MS));
    }
  );

  server.registerTool(
    "ae_move_to_corner",
    {
      title: "Move a layer to a corner",
      description:
        "Park a layer (usually the logo bug) in TL, TR, BL, or BR with a pixel margin from the comp edge. Clears a position expression so the move sticks. Assumes the layer is not parented and not rotated.",
      inputSchema: {
        layer: z.string().describe("Layer name"),
        corner: z.enum(["TL", "TR", "BL", "BR"]).describe("Which corner"),
        comp: itemSpec.optional().describe("Comp name or id. Omit for the active comp."),
        margin: z.number().optional().describe("Pixels in from the edges. Default 64."),
      },
    },
    ({ layer, corner, comp, margin }) => wrap(moveToCornerJsx({ layer, corner, comp, margin }))
  );

  await registerGeneration(server, bridge, options);

  server.registerResource(
    "status",
    "aebridge://status",
    {
      title: "AE Bridge status",
      description: "Panel connection, open project, and whether a modal dialog is blocking AE.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(bridge.status(), null, 2),
      }],
    })
  );
}
