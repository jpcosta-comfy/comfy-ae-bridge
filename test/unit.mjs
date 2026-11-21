import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { interpretPayload } from "../src/result.js";
import { formatToken, normalizeToken, tokenOk } from "../src/tokens.js";
import { moveToCornerJsx, placeVariantsJsx, surveyJsx } from "../src/jsxlib.js";
import { buildHarness } from "../src/harness.js";

const panelSource = fs.readFileSync(new URL("../panel/eval-call.js", import.meta.url), "utf8");
const panelSandbox = { module: { exports: {} }, exports: {} };
panelSandbox.exports = panelSandbox.module.exports;
vm.runInNewContext(panelSource, panelSandbox);
const { buildExtendScriptCall } = panelSandbox.module.exports;

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS", name);
  } catch (err) {
    failed++;
    console.log("FAIL", name, err.message);
  }
}

check("token normalize ignores dashes and case", () => {
  assert.equal(normalizeToken("ab3k-9qmp-x7wd"), "AB3K9QMPX7WD");
  assert.equal(formatToken("AB3K9QMPX7WD"), "AB3K-9QMP-X7WD");
  assert.equal(tokenOk("short"), false);
  assert.equal(tokenOk("AB3K9QMPX7WD"), true);
});

check("result contract stages", () => {
  const ok = interpretPayload('{"ok":true,"value":42}', "/tmp/Launch.aep");
  assert.equal(ok.ok, true);
  assert.equal(ok.result, 42);
  assert.match(ok.project, /Launch\.aep/);

  const ev = interpretPayload('{"ok":false,"error":"ReferenceError: boom","line":3}', "/p.aep");
  assert.equal(ev.stage, "eval");
  assert.match(ev.error, /boom/);
  assert.match(ev.error, /line 3/);

  const parse = interpretPayload("not json", "/p.aep");
  assert.equal(parse.stage, "parse");

  const bare = interpretPayload("EvalScript error.", "/p.aep");
  assert.equal(bare.stage, "eval");

  const timeout = interpretPayload({ __timeout: true, timeoutMs: 1500 }, "");
  assert.equal(timeout.stage, "timeout");
  assert.match(timeout.project, /no project/);

  const dropped = interpretPayload({ __transportError: "panel disconnected mid-call" }, "/p.aep");
  assert.equal(dropped.stage, "connect");
});

check("spill file is read when the panel and bridge share a disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cab-spill-"));
  const spill = path.join(dir, "result.json");
  fs.writeFileSync(spill, JSON.stringify({ ok: true, value: { n: 7 } }));
  const res = interpretPayload(JSON.stringify({ __file: spill }), "/p.aep", { readSpill: true });
  assert.equal(res.ok, true);
  assert.equal(res.result.n, 7);
  assert.equal(fs.existsSync(spill), false);
});

check("remote spill that the relay cannot see is a parse error", () => {
  const res = interpretPayload(JSON.stringify({ __file: "/no/such/spill.json" }), "/p.aep", { readSpill: true });
  assert.equal(res.stage, "parse");
  assert.match(res.error, /expand __file/);
});

check("place-variants jsx names the template, placeholder, url, and aspect frames", () => {
  const jsx = placeVariantsJsx({
    template_comp: "Launch_Master",
    placeholder_layer: "MEDIA",
    assets: [{ url: "https://example.com/hero.mp4", label: "hero" }],
    aspects: ["16:9", "9:16", "1:1"],
    output_dir: "/tmp/renders",
  });
  assert.match(jsx, /ae_place_variants/);
  assert.match(jsx, /Launch_Master/);
  assert.match(jsx, /MEDIA/);
  assert.match(jsx, /https:\/\/example\.com\/hero\.mp4/);
  assert.match(jsx, /1920/);
  assert.match(jsx, /1080/);
  assert.match(jsx, /\/usr\/bin\/curl/);
  assert.doesNotMatch(jsx, /\blet\b|\bconst\b|=>/);
});

check("place-variants rejects an asset with no source", () => {
  assert.throws(() => placeVariantsJsx({
    template_comp: "Launch_Master",
    placeholder_layer: "MEDIA",
    assets: [{ label: "x" }],
  }), /path or a url/);
});

check("survey and corner jsx stay ES3 and carry the arguments", () => {
  const survey = surveyJsx();
  assert.match(survey, /Source Text/);
  assert.match(survey, /footageMissing/);
  const corner = moveToCornerJsx({ layer: "LOGO", corner: "tr", margin: 64, comp: "Main" });
  assert.match(corner, /LOGO/);
  assert.match(corner, /"TR"/);
  assert.match(corner, /64/);
  assert.doesNotMatch(corner, /\blet\b|\bconst\b|=>/);
});

check("harness spills above the inline limit and names both temp files", () => {
  const harness = buildHarness();
  assert.match(harness, /__USER_PATH__/);
  assert.match(harness, /__SPILL_PATH__/);
  assert.match(harness, /65536/);
  assert.match(harness, /JSON.stringify/);
  assert.match(harness, /beginSuppressDialogs/);
  assert.match(harness, /endSuppressDialogs\(false\)/);
  assert.match(harness, /File\.openDialog is disabled/);
  assert.doesNotMatch(harness, /\blet\b|\bconst\b|=>/);
});

check("harness runs in the background and returns dialog attempts as errors", () => {
  const harness = buildHarness({ includePolyfill: false })
    .replaceAll("__USER_PATH__", "/tmp/user.jsx")
    .replaceAll("__SPILL_PATH__", "/tmp/spill.json");
  const calls = { began: 0, ended: null, activated: 0 };
  function File() {}
  File.openDialog = function () { throw new Error("REAL OPEN"); };
  function Folder() {}
  Folder.selectDialog = function () { throw new Error("REAL SELECT"); };
  const context = {
    alert(msg) { throw new Error("REAL ALERT " + msg); },
    confirm() { throw new Error("REAL CONFIRM"); },
    prompt() { throw new Error("REAL PROMPT"); },
    File,
    Folder,
    app: {
      beginSuppressDialogs() { calls.began += 1; },
      endSuppressDialogs(show) { calls.ended = show; },
      activate() { calls.activated += 1; },
    },
    $: {},
    JSON,
  };
  vm.createContext(context);
  vm.runInContext(
    "$.evalFile = function () { app.activate(); alert('visible'); return 42; };",
    context,
  );
  const raw = vm.runInContext(harness, context);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /alert: visible/);
  assert.equal(calls.began, 1);
  assert.equal(calls.ended, false);
  assert.equal(calls.activated, 0);
  assert.throws(() => vm.runInContext("alert('still real')", context), /REAL ALERT/);
});

check("panel eval script writes both files and expands a spill", () => {
  const files = {};
  function File(p) {
    this.fsName = p;
  }
  File.prototype.open = function () { return true; };
  File.prototype.write = function (s) { files[this.fsName] = s; };
  File.prototype.read = function () { return files[this.fsName] || ""; };
  File.prototype.close = function () {};
  File.prototype.remove = function () { delete files[this.fsName]; };
  const spillBody = JSON.stringify({ ok: true, value: { items: "yyyy" } });
  const script = buildExtendScriptCall({
    id: "7",
    userJsx: 'var s = "a\\\\b\\"c"; s;',
    harness: '$.evalFile("__USER_PATH__"); "__SPILL_PATH__";',
  });
  const context = {
    File,
    Folder: { temp: { fsName: "C:\\AE Temp" } },
    $: {
      evalFile(file) {
        assert.equal(files["C:\\AE Temp/cab-7-user.jsx"], 'var s = "a\\\\b\\"c"; s;');
        assert.match(files[file.fsName], /\$\.evalFile\("C:\\\\AE Temp\/cab-7-user\.jsx"\)/);
        return JSON.stringify({ __file: "C:\\AE Temp\\spill.json" });
      },
    },
  };
  files["C:\\AE Temp\\spill.json"] = spillBody;
  const result = vm.runInNewContext(script, context);
  assert.equal(result, spillBody);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nunit ok");
