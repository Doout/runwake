"use strict";

const assert = require("node:assert/strict");
const terminal = require("./dist/terminal-text.js");

assert.equal(
  terminal.render("\x1b[?2004hroot@b50892fc7483:/# \x1b[7mskopeo\x1b[27m\b\b\b\b\b\bskopeo"),
  "root@b50892fc7483:/# skopeo",
);
assert.equal(terminal.render("Downloading 10%\rDownloading 100%"), "Downloading 100%");
assert.equal(terminal.render("status: waiting\x1b[2K\rstatus: ready"), "status: ready");
assert.equal(terminal.render("secret\x1b[6Dpublic"), "public");
assert.equal(terminal.render("one\nline up\x1b[1A\rONE"), "ONE\nline up");
