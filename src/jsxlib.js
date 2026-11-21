// Shared ES3 helpers prepended to every named-tool script.
// Adapted from Comfy's internal AE Bridge: item index, deduped import, comp lookup.

export const JSX_LIB = `
var __itemMap = null;
function __buildItemIndex() {
  __itemMap = { byId: {}, byName: {}, n: app.project.numItems };
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    __itemMap.byId[it.id] = it;
    if (!(it.name in __itemMap.byName)) __itemMap.byName[it.name] = it;
  }
}
function __findItem(spec) {
  if (!__itemMap || __itemMap.n !== app.project.numItems) __buildItemIndex();
  if (typeof spec === "number") return __itemMap.byId[spec] || null;
  return __itemMap.byName[spec] || __itemMap.byId[spec] || null;
}
function __itemBrief(it) {
  return { id: it.id, name: it.name, type: it.typeName };
}
function __compOrActive(spec) {
  var c;
  if (spec === null || spec === undefined) { c = app.project.activeItem; }
  else { c = __findItem(spec); }
  return (c && c instanceof CompItem) ? c : null;
}
function __findFolder(nm) {
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof FolderItem && it.name === nm) return it;
  }
  return null;
}
function __importDedup(path, folder) {
  var f = new File(path);
  if (!f.exists) return null;
  var fsn = f.fsName;
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof FootageItem && it.file && it.file.fsName === fsn) return it;
  }
  var item = app.project.importFile(new ImportOptions(f));
  if (folder) item.parentFolder = folder;
  return item;
}
function __shq(s) {
  return "'" + String(s).replace(/'/g, "'\\\\''") + "'";
}
`;

export function jsxWithArgs(args, body) {
  return `var ARGS = ${JSON.stringify(args)};\n${JSX_LIB}\n(function () {\n${body}\n})();\n`;
}

const ASPECTS = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
};

export function knownAspects() {
  return Object.keys(ASPECTS);
}

export function guessExt(asset) {
  const fromPath = asset.path && String(asset.path).match(/\.([a-z0-9]{2,5})$/i);
  if (fromPath) return fromPath[1].toLowerCase();
  const fromUrl = asset.url && String(asset.url).match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  return "mp4";
}

export function placeVariantsJsx(args) {
  const aspects = args.aspects?.length ? args.aspects : ["16:9", "9:16", "1:1"];
  for (const key of aspects) {
    if (!ASPECTS[key]) throw new Error(`unknown aspect: ${key}`);
  }
  if (!args.template_comp) throw new Error("template_comp is required");
  if (!args.placeholder_layer) throw new Error("placeholder_layer is required");
  if (!args.assets?.length) throw new Error("assets must list at least one clip or image");
  const assets = args.assets.map((asset, i) => {
    if (!asset.path && !asset.url) throw new Error(`asset ${i + 1} needs a path or a url`);
    return {
      path: asset.path || null,
      url: asset.url || null,
      label: asset.label || `v${i + 1}`,
      ext: guessExt(asset),
    };
  });
  const payload = {
    template_comp: args.template_comp,
    placeholder_layer: args.placeholder_layer,
    assets,
    aspects,
    sizes: ASPECTS,
    output_dir: args.output_dir || null,
    fit: args.fit === "contain" ? "contain" : "cover",
    fit_layer: !!args.fit_layer,
    rs_template: args.rs_template || null,
    om_template: args.om_template || null,
    start_render: !!args.start_render,
  };
  return jsxWithArgs(payload, PLACE_VARIANTS_BODY);
}

const PLACE_VARIANTS_BODY = `
  /* ae_place_variants */
  var template = __findItem(ARGS.template_comp);
  if (!template || !(template instanceof CompItem)) throw new Error("template comp not found: " + ARGS.template_comp);
  var outDir = ARGS.output_dir;
  if (!outDir) {
    if (app.project.file) outDir = app.project.file.parent.fsName + "/comfy-renders";
    else throw new Error("output_dir is required when the project has not been saved");
  }
  var outFolder = new Folder(outDir);
  if (!outFolder.exists && !outFolder.create()) throw new Error("could not create output_dir: " + outDir);
  var incoming = new Folder(outDir + "/_incoming");
  if (!incoming.exists) incoming.create();
  var projFolder = __findFolder("Comfy Variants") || app.project.items.addFolder("Comfy Variants");
  var queued = [];
  app.beginUndoGroup("ae_place_variants");
  try {
    for (var a = 0; a < ARGS.assets.length; a++) {
      var asset = ARGS.assets[a];
      var label = asset.label;
      var filePath = asset.path;
      if (!filePath && asset.url) {
        filePath = incoming.fsName + "/" + label.replace(/[^A-Za-z0-9_-]/g, "_") + "." + asset.ext;
        var dest = new File(filePath);
        var curl = ($.os.indexOf("Windows") === 0) ? "curl.exe" : "/usr/bin/curl";
        var cmd = curl + " -fsSL --max-time 180 -o " + __shq(dest.fsName) + " " + __shq(asset.url);
        system.callSystem(cmd);
        if (!dest.exists) throw new Error("download failed: " + asset.url);
      }
      var footage = __importDedup(filePath, projFolder);
      if (!footage) throw new Error("file not found: " + filePath);
      var variant = template.duplicate();
      variant.name = template.name + " / " + label;
      variant.parentFolder = projFolder;
      var placeholder = null;
      for (var L = 1; L <= variant.numLayers; L++) {
        if (variant.layer(L).name === ARGS.placeholder_layer) { placeholder = variant.layer(L); break; }
      }
      if (!placeholder) throw new Error("placeholder layer not found in " + variant.name + ": " + ARGS.placeholder_layer);
      placeholder.replaceSource(footage, false);
      if (ARGS.fit_layer && footage.width && footage.height) {
        try { placeholder.property("Anchor Point").setValue([footage.width / 2, footage.height / 2]); } catch (eA) {}
        var fitSrc = Math.min(variant.width / footage.width, variant.height / footage.height);
        placeholder.property("Scale").setValue([fitSrc * 100, fitSrc * 100]);
        try {
          var pos = placeholder.property("Position");
          try { pos.expression = ""; } catch (eE) {}
          pos.setValue([variant.width / 2, variant.height / 2]);
        } catch (eP) {}
      }
      for (var r = 0; r < ARGS.aspects.length; r++) {
        var key = ARGS.aspects[r];
        var size = ARGS.sizes[key];
        var safe = label.replace(/[^A-Za-z0-9_-]/g, "_");
        var aspectName = key.replace(":", "x");
        var frame = app.project.items.addComp(safe + "_" + aspectName, size[0], size[1], variant.pixelAspect, variant.duration, variant.frameRate);
        frame.parentFolder = projFolder;
        var layer = frame.layers.add(variant);
        var sx = size[0] / variant.width;
        var sy = size[1] / variant.height;
        var scale = (ARGS.fit === "contain") ? Math.min(sx, sy) : Math.max(sx, sy);
        layer.property("Scale").setValue([scale * 100, scale * 100]);
        var rqi = app.project.renderQueue.items.add(frame);
        if (ARGS.rs_template) rqi.applyTemplate(ARGS.rs_template);
        var om = rqi.outputModule(1);
        if (ARGS.om_template) om.applyTemplate(ARGS.om_template);
        var outPath = outDir + "/" + safe + "_" + aspectName + ".mp4";
        om.file = new File(outPath);
        queued.push({
          label: label,
          aspect: key,
          comp: frame.name,
          variant: variant.name,
          output: om.file ? om.file.fsName : outPath,
          rqIndex: app.project.renderQueue.numItems
        });
      }
    }
  } finally {
    app.endUndoGroup();
  }
  var started = false;
  if (ARGS.start_render) {
    app.project.renderQueue.render();
    started = true;
  }
  return { queued: queued, outputDir: outDir, started: started, fit: ARGS.fit };
`;

export function surveyJsx() {
  return jsxWithArgs({}, `
  var comps = [];
  var footage = [];
  var truncated = false;
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof CompItem) {
      if (comps.length >= 200) { truncated = true; continue; }
      var layers = [];
      var limit = it.numLayers;
      if (limit > 80) { truncated = true; limit = 80; }
      for (var L = 1; L <= limit; L++) {
        var ly = it.layer(L);
        var src = ly.source;
        var kind = "layer";
        if (ly instanceof TextLayer) kind = "text";
        else if (ly instanceof ShapeLayer) kind = "shape";
        else if (ly instanceof CameraLayer) kind = "camera";
        else if (ly instanceof LightLayer) kind = "light";
        else if (src && (src instanceof CompItem)) kind = "precomp";
        else if (src) kind = "footage";
        var o = {
          index: L,
          name: ly.name,
          kind: kind,
          enabled: ly.enabled,
          sourceName: src ? src.name : null,
          sourceId: src ? src.id : null,
          file: (src && src.file) ? src.file.fsName : null,
          missing: (src && src.footageMissing) ? true : false
        };
        try {
          var st = ly.property("Source Text");
          if (st && st.value && st.value.text) o.text = String(st.value.text).substring(0, 240);
        } catch (e1) {}
        layers.push(o);
      }
      comps.push({
        id: it.id,
        name: it.name,
        width: it.width,
        height: it.height,
        duration: it.duration,
        frameRate: it.frameRate,
        numLayers: it.numLayers,
        layers: layers
      });
    } else if (it instanceof FootageItem) {
      if (footage.length >= 400) { truncated = true; continue; }
      footage.push({
        id: it.id,
        name: it.name,
        path: it.file ? it.file.fsName : null,
        missing: it.footageMissing ? true : false,
        width: it.width,
        height: it.height
      });
    }
  }
  return {
    numItems: app.project.numItems,
    truncated: truncated,
    comps: comps,
    footage: footage
  };
`);
}

export function moveToCornerJsx(args) {
  return jsxWithArgs({
    comp: args.comp ?? null,
    layer: args.layer,
    corner: String(args.corner || "TR").toUpperCase(),
    margin: args.margin == null ? 64 : args.margin,
  }, `
  var corners = { TL: 1, TR: 1, BL: 1, BR: 1 };
  if (!corners[ARGS.corner]) throw new Error("corner must be TL, TR, BL, or BR");
  var c = __compOrActive(ARGS.comp);
  if (!c) throw new Error("comp not found / no active comp");
  var ly = null;
  for (var i = 1; i <= c.numLayers; i++) if (c.layer(i).name === ARGS.layer) { ly = c.layer(i); break; }
  if (!ly) throw new Error("layer not found: " + ARGS.layer);
  var rect = ly.sourceRectAtTime(c.time, false);
  if (!rect) throw new Error("could not measure layer bounds: " + ARGS.layer);
  var m = ARGS.margin;
  var x = m - rect.left;
  var y = m - rect.top;
  if (ARGS.corner === "TR" || ARGS.corner === "BR") x = c.width - m - rect.width - rect.left;
  if (ARGS.corner === "BL" || ARGS.corner === "BR") y = c.height - m - rect.height - rect.top;
  var pos = ly.property("Position");
  try { pos.expression = ""; } catch (e0) {}
  app.beginUndoGroup("ae_move_to_corner");
  try {
    try {
      pos.setValue([x, y]);
    } catch (e1) {
      pos.property("ADBE Position_0").setValue(x);
      pos.property("ADBE Position_1").setValue(y);
    }
  } finally {
    app.endUndoGroup();
  }
  return { comp: c.name, layer: ly.name, corner: ARGS.corner, margin: m, position: [x, y] };
`);
}
