import fs from "node:fs";

// Turn the string evalScript handed back into the ae_* result contract.
// Stages: connect | eval | timeout | parse | dialog.

export function projectLabel(project) {
  return project || "(no project file — unsaved or none open)";
}

export function interpretPayload(payload, project, opts = {}) {
  const label = projectLabel(project);
  if (payload && typeof payload === "object" && payload.__timeout) {
    return {
      ok: false,
      stage: "timeout",
      error: `no result within ${payload.timeoutMs}ms — After Effects may be blocked by a modal dialog`,
      project: label,
    };
  }
  if (payload && typeof payload === "object" && payload.__transportError) {
    return { ok: false, stage: "connect", error: String(payload.__transportError), project: label };
  }
  if (typeof payload !== "string" || payload === "EvalScript error.") {
    return {
      ok: false,
      stage: "eval",
      error: "evalScript failed at the ExtendScript level (harness did not run)",
      project: label,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (e) {
    return {
      ok: false,
      stage: "parse",
      error: `could not parse result: ${e.message}; raw (first 500 chars): ${payload.slice(0, 500)}`,
      project: label,
    };
  }

  if (parsed && typeof parsed.__file === "string") {
    const spill = parsed.__file;
    if (!opts.readSpill || !fs.existsSync(spill)) {
      return {
        ok: false,
        stage: "parse",
        error:
          "result spilled to a file the bridge cannot read. The panel should expand __file before sending. " +
          `path: ${spill}`,
        project: label,
      };
    }
    try {
      parsed = JSON.parse(fs.readFileSync(spill, "utf8"));
    } catch (e) {
      return {
        ok: false,
        stage: "parse",
        error: `could not read spill file: ${e.message}`,
        project: label,
      };
    } finally {
      try { fs.rmSync(spill, { force: true }); } catch { /* ignore */ }
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, stage: "parse", error: "result JSON was not an object", project: label };
  }
  const info = parsed.projectInfo && typeof parsed.projectInfo === "object" ? parsed.projectInfo : null;
  let reported = projectLabel(typeof parsed.project === "string" ? parsed.project : project);
  if (info?.open && info.path) reported = info.path;
  else if (info?.open && !info.saved) reported = `${info.name || "(unsaved project)"} (unsaved, ${info.numItems} items)`;
  const envelope = info ? { projectInfo: info } : {};
  if (!parsed.ok) {
    return {
      ok: false,
      stage: "eval",
      error: String(parsed.error || "jsx error") + (parsed.line ? ` (line ${parsed.line})` : ""),
      project: reported,
      ...envelope,
    };
  }
  return { ok: true, result: parsed.value, project: reported, ...envelope };
}
