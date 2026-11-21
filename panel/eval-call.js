// Builds the ExtendScript that writes the user script + harness on the AE
// machine, runs the harness, and expands a >64KB spill file before returning.
// Classic script so the CEP panel can load it, and module.exports so tests can.

function buildExtendScriptCall(msg) {
  var idSafe = String(msg.id).replace(/[^0-9A-Za-z_-]/g, "") || "0";
  return [
    "(function () {",
    "  var userSrc = " + JSON.stringify(msg.userJsx) + ";",
    "  var harnessSrc = " + JSON.stringify(msg.harness) + ";",
    "  var userFile = new File(Folder.temp.fsName + '/cab-" + idSafe + "-user.jsx');",
    "  var spillFile = new File(Folder.temp.fsName + '/cab-" + idSafe + "-result.json');",
    "  var harnessFile = new File(Folder.temp.fsName + '/cab-" + idSafe + "-harness.jsx');",
    "  function escPath(p) {",
    "    var s = String(p);",
    "    var out = '';",
    "    for (var i = 0; i < s.length; i++) {",
    "      var ch = s.charAt(i);",
    "      if (ch === '\\\\') out += '\\\\\\\\';",
    "      else if (ch === '\"') out += '\\\\\"';",
    "      else out += ch;",
    "    }",
    "    return out;",
    "  }",
    "  function write(f, s) {",
    "    f.encoding = 'UTF-8';",
    "    if (!f.open('w')) return 'open failed';",
    "    f.write(s);",
    "    f.close();",
    "    return '';",
    "  }",
    "  harnessSrc = harnessSrc.split('__USER_PATH__').join(escPath(userFile.fsName));",
    "  harnessSrc = harnessSrc.split('__SPILL_PATH__').join(escPath(spillFile.fsName));",
    "  var e1 = write(userFile, userSrc);",
    "  if (e1) return '{\"ok\":false,\"error\":\"' + e1 + '\"}';",
    "  var e2 = write(harnessFile, harnessSrc);",
    "  if (e2) return '{\"ok\":false,\"error\":\"' + e2 + '\"}';",
    "  var out = $.evalFile(harnessFile);",
    "  try { userFile.remove(); harnessFile.remove(); } catch (e) {}",
    "  if (out && String(out).indexOf('__file') !== -1) {",
    "    try {",
    "      var meta = eval('(' + out + ')');",
    "      if (meta && meta.__file) {",
    "        var rf = new File(meta.__file);",
    "        rf.encoding = 'UTF-8';",
    "        if (rf.open('r')) {",
    "          var body = rf.read();",
    "          rf.close();",
    "          try { rf.remove(); } catch (e2) {}",
    "          return body;",
    "        }",
    "      }",
    "    } catch (e3) {}",
    "  }",
    "  return out;",
    "})();",
  ].join("\n");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildExtendScriptCall: buildExtendScriptCall };
}
