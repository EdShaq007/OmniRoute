import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ActivationDependencies } from "../../src/lib/services/managedProxy/manager.ts";

fs.mkdirSync(path.join(process.cwd(), "_artifacts"), { recursive: true });
const sandbox = fs.mkdtempSync(path.join(process.cwd(), "_artifacts", "managed-test-"));
for (const key of [
  "DATA_DIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
])
  process.env[key] = sandbox;
for (const key of ["SQLITE_FILE", "OMNIROUTE_SQLITE_FILE"])
  process.env[key] = path.join(sandbox, "storage.sqlite");
delete process.env.OMNIROUTE_ALLOW_DEFAULT_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-test-key-not-an-operator-secret";
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { saveManagedProxy, managedEntries } =
  await import("../../src/lib/services/managedProxy/manager.ts");
const UUID = "11111111-1111-4111-8111-111111111111";

test(
  "managed saves commit only after readiness and restore encrypted state on assignment failure",
  { timeout: 3000 },
  async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "_artifacts", "managed-save-"));
    const calls: string[] = [];
    let port = 24000;
    const deps: ActivationDependencies = {
      install: async () => "synthetic-binary",
      check: async () => {
        calls.push("check");
      },
      start: async () => {
        calls.push("start");
      },
      stop: async () => {
        calls.push("stop");
      },
      allocate: async () => ++port,
    };
    try {
      const first = await saveManagedProxy(
        {
          core: "singbox",
          name: "first",
          sourceLink: `vless://${UUID}@example.invalid:443?security=tls`,
        },
        async (entry) => {
          calls.push("commit");
          return entry;
        },
        root,
        deps
      );
      assert.deepEqual(calls, ["check", "stop", "start", "commit"]);
      const manifest = fs.readFileSync(path.join(root, "singbox", "sources.json"), "utf8");
      assert.ok(!manifest.includes(UUID));
      assert.ok(manifest.includes("enc:v1:"));
      const config = fs.readFileSync(path.join(root, "singbox", "config.json"), "utf8");
      await assert.rejects(
        saveManagedProxy(
          {
            core: "singbox",
            name: "second",
            sourceLink: `vless://${UUID}@example.invalid:443?security=tls`,
          },
          async () => {
            throw new Error("Synthetic assignment failure");
          },
          root,
          deps
        ),
        /Synthetic assignment failure/
      );
      assert.equal(fs.readFileSync(path.join(root, "singbox", "sources.json"), "utf8"), manifest);
      assert.equal(fs.readFileSync(path.join(root, "singbox", "config.json"), "utf8"), config);
      assert.deepEqual(managedEntries("singbox", root), [
        { id: first.id, name: "first", core: "singbox", port: first.port },
      ]);
      assert.ok(
        !fs.readdirSync(path.join(root, "singbox")).some((name) => name.startsWith("candidate-"))
      );
      const before = calls.length;
      await assert.rejects(
        saveManagedProxy(
          {
            core: "singbox",
            id: first.id,
            name: "replacement",
            sourceLink: `vless://${UUID}@example.invalid:443?security=tls`,
          },
          async () => {
            throw new Error("replacement rejected");
          },
          root,
          { ...deps, running: () => false }
        ),
        /replacement rejected/
      );
      assert.deepEqual(calls.slice(before), ["check", "stop", "start", "stop"]);
      const oppositeId = "22222222-2222-4222-8222-222222222222";
      fs.mkdirSync(path.join(root, "xray"));
      const encrypted = JSON.parse(manifest).entries[0].sourceEnc;
      fs.writeFileSync(
        path.join(root, "xray", "sources.json"),
        JSON.stringify({
          version: 1,
          entries: [
            { id: oppositeId, name: "stopped opposite", port: 25000, sourceEnc: encrypted },
          ],
        }),
        "utf8"
      );
      await saveManagedProxy(
        {
          core: "singbox",
          name: "new",
          sourceLink: `vless://${UUID}@example.invalid:443?security=tls`,
        },
        async (entry) => entry,
        root,
        {
          ...deps,
          allocate: async (excluded) => {
            assert.ok(excluded.has(25000));
            assert.ok(excluded.has(first.port));
            return 25001;
          },
        }
      );
      const guardSource = fs.readFileSync(
        path.join(process.cwd(), "src", "server", "authz", "routeGuard.ts"),
        "utf8"
      );
      assert.ok(guardSource.includes('"/api/services/"'));
      const bypassSource = fs.readFileSync(
        path.join(process.cwd(), "src", "shared", "constants", "spawnCapablePrefixes.ts"),
        "utf8"
      );
      assert.ok(bypassSource.includes('"/api/services/"'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
