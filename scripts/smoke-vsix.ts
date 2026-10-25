/**
 * VSIX Clean-Profile Smoke Test Runner
 *
 * Tests a packaged .vsix artifact using @vscode/test-electron:
 * 1. Computes and prints the VSIX SHA-256 and size first.
 * 2. Creates an isolated temporary environment (clean user-data-dir and extensions-dir).
 * 3. Installs only the target VSIX into the clean environment (never --disable-extensions).
 * 4. Launches VS Code opening demo-project.
 * 5. Asserts:
 *    - The extension is discovered and activated.
 *    - Every command declared in package.json contributes.commands is registered.
 *    - Shipped configuration defaults match package.json (changeSeeds: false, maxFiles: 40, etc.).
 *    - offlineCodeContext.indexWorkspace runs without error.
 *    - Index status / manifest on disk reports indexed files (> 0).
 * 6. Cleans up all temporary directories and exits non-zero on failure.
 *
 * Usage:
 *   npx tsx scripts/smoke-vsix.ts [path-to-vsix]
 *   npm run smoke:vsix -- [path-to-vsix]
 */
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

const ROOT = path.resolve(__dirname, "..");
const DEMO_PROJECT = path.join(ROOT, "demo-project");

function resolveVsixPath(arg?: string): string {
  if (arg) {
    const resolved = path.resolve(process.cwd(), arg);
    if (!fs.existsSync(resolved)) {
      console.error(`FAIL: Specified VSIX not found: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }

  // Look for vsix matching current package.json version
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    version?: string;
  };
  if (pkg.version) {
    const versionVsix = path.join(ROOT, `offline-code-context-compiler-${pkg.version}.vsix`);
    if (fs.existsSync(versionVsix)) {
      return versionVsix;
    }
  }

  // Otherwise find vsix in workspace root and pick the newest
  const matches = fs
    .readdirSync(ROOT)
    .filter((f) => f.startsWith("offline-code-context-compiler-") && f.endsWith(".vsix"))
    .map((f) => ({
      path: path.join(ROOT, f),
      mtime: fs.statSync(path.join(ROOT, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (matches.length > 0) {
    return matches[0].path;
  }

  console.error(
    "FAIL: No VSIX file specified and none found in workspace root. Run `npm run package` first.",
  );
  process.exit(1);
}

function computeVsixHash(filePath: string): { sha256: string; size: number } {
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const size = fs.statSync(filePath).size;
  return { sha256, size };
}

async function main(): Promise<void> {
  const vsixPath = resolveVsixPath(process.argv[2]);

  // Requirement: Print the vsix SHA-256 first
  const { sha256, size } = computeVsixHash(vsixPath);
  console.log(`[smoke:vsix] Target VSIX: ${vsixPath}`);
  console.log(`[smoke:vsix] VSIX SHA-256: ${sha256}`);
  console.log(`[smoke:vsix] VSIX Size: ${size} bytes`);

  if (!fs.existsSync(DEMO_PROJECT)) {
    console.error(`FAIL: demo-project not found at ${DEMO_PROJECT}`);
    process.exit(1);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-smoke-vsix-"));
  const extensionsDir = path.join(tempDir, "ext");
  const userDataDir = path.join(tempDir, "user");
  const harnessDir = path.join(tempDir, "harness");

  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(harnessDir, { recursive: true });

  let exitCode = 1;

  try {
    // 1. Resolve VS Code binary
    console.log("[smoke:vsix] Resolving VS Code via @vscode/test-electron...");
    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
      reuseMachineInstall: true,
    });

    // 2. Install only the target VSIX into the clean extensions directory
    console.log("[smoke:vsix] Installing target VSIX into isolated clean profile...");
    const install = cp.spawnSync(
      cli,
      [
        ...cliArgs,
        `--extensions-dir=${extensionsDir}`,
        `--user-data-dir=${userDataDir}`,
        "--install-extension",
        vsixPath,
      ],
      {
        encoding: "utf8",
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );

    if (install.status !== 0) {
      throw new Error(`VS Code CLI failed to install VSIX (exit code ${install.status})`);
    }

    // 3. Write minimal test harness
    fs.writeFileSync(
      path.join(harnessDir, "package.json"),
      JSON.stringify({
        name: "occ-smoke-harness",
        publisher: "test",
        version: "1.0.0",
        engines: { vscode: "^1.85.0" },
      }),
    );

    const runnerScript = `
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

exports.run = async function run() {
  console.log("[smoke:runner] Starting clean-profile VSIX assertion suite inside VS Code extension host...");

  // Assertion 1: extension found and active
  const extensionId = "offline-code-context.offline-code-context-compiler";
  const ext = vscode.extensions.getExtension(extensionId);
  assert.ok(ext, "Assertion Failed: Extension '" + extensionId + "' was not found in installed extensions");
  console.log("[smoke:runner] Found installed extension: " + ext.id + " v" + ext.packageJSON.version);

  if (!ext.isActive) {
    console.log("[smoke:runner] Activating extension...");
    await ext.activate();
  }
  assert.strictEqual(ext.isActive, true, "Assertion Failed: Extension must be active");
  console.log("[smoke:runner] PASS: Extension is active");

  // Assertion 2: every command in package.json contributes.commands is registered
  const manifestCommands = ext.packageJSON.contributes?.commands || [];
  assert.ok(manifestCommands.length > 0, "Assertion Failed: package.json contributes.commands is empty");
  const allCommands = await vscode.commands.getCommands(true);
  const missing = [];
  for (const c of manifestCommands) {
    if (!allCommands.includes(c.command)) {
      missing.push(c.command);
    }
  }
  assert.strictEqual(
    missing.length,
    0,
    "Assertion Failed: The following commands are not registered: " + missing.join(", ")
  );
  console.log("[smoke:runner] PASS: All " + manifestCommands.length + " contributes.commands are registered");

  // Assertion 3: shipped defaults match package.json (changeSeeds false, maxFiles, and configuration schema)
  const config = vscode.workspace.getConfiguration("offlineCodeContext");
  const changeSeeds = config.get("changeSeeds");
  assert.strictEqual(changeSeeds, false, "Assertion Failed: Default changeSeeds must be false");
  const maxFiles = config.get("maxFiles");
  assert.strictEqual(maxFiles, 40, "Assertion Failed: Default maxFiles must be 40");

  const properties = ext.packageJSON.contributes?.configuration?.properties || {};
  for (const [key, schema] of Object.entries(properties)) {
    const propName = key.replace(/^offlineCodeContext\\./, "");
    if (schema && Object.prototype.hasOwnProperty.call(schema, "default")) {
      const actual = config.get(propName);
      assert.deepStrictEqual(
        actual,
        schema.default,
        "Assertion Failed: Default mismatch for setting " + key + ": expected " +
          JSON.stringify(schema.default) + ", got " + JSON.stringify(actual)
      );
    }
  }
  console.log("[smoke:runner] PASS: Shipped configuration defaults match package.json");

  // Assertion 4: indexWorkspace runs without error and index status reports files
  console.log("[smoke:runner] Executing offlineCodeContext.indexWorkspace on demo-project...");
  await vscode.commands.executeCommand("offlineCodeContext.indexWorkspace");
  console.log("[smoke:runner] Command offlineCodeContext.indexWorkspace completed without error");

  // Trigger showIndexStatus
  await vscode.commands.executeCommand("offlineCodeContext.showIndexStatus");

  // Search user-data-dir for the generated manifest.json in workspaceStorage
  function searchManifest(dir) {
    if (!fs.existsSync(dir)) return null;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        const found = searchManifest(full);
        if (found) return found;
      } else if (item.name === "manifest.json") {
        return full;
      }
    }
    return null;
  }

  const userDataDir = process.env.OCC_SMOKE_USER_DATA;
  const manifestPath = searchManifest(userDataDir);
  assert.ok(manifestPath, "Assertion Failed: manifest.json not found in storage under " + userDataDir);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const indexedFiles = manifest.entryCount ?? Object.keys(manifest.files || {}).length;
  console.log("[smoke:runner] Manifest found at: " + manifestPath + " (reports " + indexedFiles + " indexed files)");
  assert.ok(indexedFiles > 0, "Assertion Failed: manifest reports 0 indexed files");
  console.log("[smoke:runner] PASS: Index status reports " + indexedFiles + " files");

  console.log("[smoke:runner] ALL VSIX SMOKE TEST ASSERTIONS PASSED SUCCESSFULLY.");
};
`;
    fs.writeFileSync(path.join(harnessDir, "runner.js"), runnerScript);

    // 4. Launch VS Code with test runner
    console.log("[smoke:vsix] Launching VS Code with demo-project and clean profile...");
    exitCode = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: harnessDir,
      extensionTestsPath: path.join(harnessDir, "runner.js"),
      launchArgs: [
        DEMO_PROJECT,
        `--extensions-dir=${extensionsDir}`,
        `--user-data-dir=${userDataDir}`,
      ],
      extensionTestsEnv: {
        OCC_SMOKE_USER_DATA: userDataDir,
      },
    });

    if (exitCode === 0) {
      console.log(`[smoke:vsix] SUCCESS: VSIX smoke test passed on ${vsixPath}`);
    } else {
      console.error(`[smoke:vsix] FAIL: VSIX smoke test failed with exit code ${exitCode}`);
    }
  } finally {
    // Requirement: Clean temp dirs
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[smoke:vsix] Warning: failed to clean temp directory ${tempDir}:`, e);
    }
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

void main().catch((err) => {
  console.error("[smoke:vsix] Unhandled error:", err);
  process.exit(1);
});
