import assert from "node:assert/strict";
import { clientOs, normalizeClientOsArgs, roundUpToMultiple } from "../src/client-os.js";
import { officialDownloadUrl } from "../src/cloud.js";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, err.message);
  }
}

check("macos aliases become darwin", () => {
  for (const alias of ["macos", "mac", "osx", "MacOS", "darwin"]) {
    assert.equal(clientOs(alias, "linux"), "darwin");
  }
  assert.equal(clientOs("windows", "darwin"), "win32");
  assert.equal(clientOs("win32", "darwin"), "win32");
  assert.equal(clientOs("", "darwin"), "darwin");
  assert.equal(clientOs(undefined, "linux"), "linux");
});

check("proxy args normalize client_os in params and at the top level", () => {
  const next = normalizeClientOsArgs({
    name: "image_z_image_turbo",
    client_os: "macos",
    params: { prompt: "hero", client_os: "osx" },
  }, "linux");
  assert.equal(next.client_os, "darwin");
  assert.equal(next.params.client_os, "darwin");
  assert.equal(next.params.prompt, "hero");
});

check("generation sizes round up to a multiple of 16", () => {
  assert.equal(roundUpToMultiple(1920), 1920);
  assert.equal(roundUpToMultiple(1080), 1088);
  assert.equal(roundUpToMultiple(1081), 1088);
  assert.equal(roundUpToMultiple(1), 16);
});

check("official download keeps the shortlink instead of the asset content route", () => {
  const url = officialDownloadUrl({
    id: "asset-9",
    url: "http://cloud.comfy.org/api/s/abc123",
  });
  assert.equal(url, "https://cloud.comfy.org/api/s/abc123");
  const relative = officialDownloadUrl({ url: "/api/s/abc123" });
  assert.equal(relative, "https://cloud.comfy.org/api/s/abc123");
  const fallback = officialDownloadUrl({ id: "asset-9" });
  assert.equal(fallback, "https://cloud.comfy.org/api/v2/assets/asset-9/content");
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\npolish ok");
