import assert from "node:assert/strict";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { archiveExecutable } from "../../src/lib/services/managedProxy/install.ts";
import { officialRelease } from "../../src/lib/services/managedProxy/releases.ts";

test(
  "core archive extraction returns only expected binary and rejects traversal or symlink",
  { timeout: 2000 },
  async () => {
    const zip = new AdmZip();
    zip.addFile("release/sing-box.exe", Buffer.from("synthetic-binary"));
    assert.equal(
      (await archiveExecutable(zip.toBuffer(), "core.zip", "sing-box.exe")).toString("utf8"),
      "synthetic-binary"
    );
    const link = new AdmZip();
    link.addFile("xray.exe", Buffer.from("synthetic-target"));
    link.getEntry("xray.exe")!.attr = 0xa000 << 16;
    await assert.rejects(
      archiveExecutable(link.toBuffer(), "core.zip", "xray.exe"),
      /link or special file/
    );
    const duplicate = new AdmZip();
    duplicate.addFile("first/xray.exe", Buffer.from("one"));
    duplicate.addFile("second/xray.exe", Buffer.from("two"));
    await assert.rejects(
      archiveExecutable(duplicate.toBuffer(), "core.zip", "xray.exe"),
      /exactly one/
    );
    assert.equal(officialRelease("xray", "win32", "x64").executable, "xray.exe");
    assert.equal(officialRelease("singbox", "linux", "x64").sha256.length, 64);
    assert.throws(() => officialRelease("singbox", "freebsd", "x64"), /No verified/);
  }
);
