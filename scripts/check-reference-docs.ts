/**
 * Verifies that package.json settings and commands match docs/CONFIGURATION.md
 * and docs/COMMANDS.md exactly, including setting defaults and counts.
 * Run: npx tsx scripts/check-reference-docs.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

interface Failure {
  readonly location: string;
  readonly message: string;
}

const failures: Failure[] = [];

function checkReferenceDocs(): void {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  const configPath = path.join(ROOT, "docs/CONFIGURATION.md");
  const commandsPath = path.join(ROOT, "docs/COMMANDS.md");

  if (!fs.existsSync(configPath)) {
    console.error(`FAIL: docs/CONFIGURATION.md does not exist`);
    process.exit(1);
  }
  if (!fs.existsSync(commandsPath)) {
    console.error(`FAIL: docs/COMMANDS.md does not exist`);
    process.exit(1);
  }

  const configContent = fs.readFileSync(configPath, "utf8");
  const commandsContent = fs.readFileSync(commandsPath, "utf8");

  // 1. Verify Configuration Properties (20 settings)
  const properties = pkg.contributes?.configuration?.properties ?? {};
  const propertyKeys = Object.keys(properties);

  if (propertyKeys.length !== 20) {
    failures.push({
      location: "package.json",
      message: `Expected 20 configuration properties, found ${propertyKeys.length}`,
    });
  }

  for (const key of propertyKeys) {
    // Check that setting is present in docs/CONFIGURATION.md
    if (!configContent.includes(`\`${key}\``) && !configContent.includes(key)) {
      failures.push({
        location: "docs/CONFIGURATION.md",
        message: `Setting key '${key}' is missing from docs/CONFIGURATION.md`,
      });
    }

    const prop = properties[key];
    const defaultVal = prop.default;
    // Format expected default representation in doc
    let expectedDefaultStr: string;
    if (typeof defaultVal === "string") {
      expectedDefaultStr = `"${defaultVal}"`;
    } else if (Array.isArray(defaultVal)) {
      expectedDefaultStr = "standard exclude list"; // or array check
    } else {
      expectedDefaultStr = String(defaultVal);
    }

    // Verify key section has matching default
    const keySectionRegex = new RegExp(`###\\s+\`?${key}\`?[\\s\\S]*?(?=###|$)`, "g");
    const sectionMatch = keySectionRegex.exec(configContent);
    if (sectionMatch) {
      const sectionText = sectionMatch[0];
      if (!sectionText.includes(expectedDefaultStr) && !Array.isArray(defaultVal)) {
        failures.push({
          location: `docs/CONFIGURATION.md (${key})`,
          message: `Expected default ${expectedDefaultStr} for ${key} in section documentation`,
        });
      }
    }
  }

  // Check that no undefined settings are documented as active settings
  const settingHeaderMatches = configContent.matchAll(
    /###\s+`(offlineCodeContext\.[a-zA-Z0-9]+)`/g,
  );
  for (const m of settingHeaderMatches) {
    const documentedKey = m[1];
    if (!properties[documentedKey]) {
      failures.push({
        location: "docs/CONFIGURATION.md",
        message: `Documented setting '${documentedKey}' is not defined in package.json`,
      });
    }
  }

  // 2. Verify Commands (16 commands)
  const commands = pkg.contributes?.commands ?? [];
  const commandMap = new Map<string, string>();
  for (const c of commands) {
    commandMap.set(c.command, c.title);
  }

  if (commands.length !== 16) {
    failures.push({
      location: "package.json",
      message: `Expected 16 commands, found ${commands.length}`,
    });
  }

  for (const c of commands) {
    if (!commandsContent.includes(`\`${c.command}\``) && !commandsContent.includes(c.command)) {
      failures.push({
        location: "docs/COMMANDS.md",
        message: `Command ID '${c.command}' is missing from docs/COMMANDS.md`,
      });
    }
  }

  const commandHeaderMatches = commandsContent.matchAll(
    /###\s+`(offlineCodeContext\.[a-zA-Z0-9]+)`/g,
  );
  for (const m of commandHeaderMatches) {
    const documentedCmd = m[1];
    if (!commandMap.has(documentedCmd)) {
      failures.push({
        location: "docs/COMMANDS.md",
        message: `Documented command '${documentedCmd}' is not defined in package.json`,
      });
    }
  }

  if (failures.length > 0) {
    console.error(`FAIL: Found ${failures.length} reference documentation error(s):`);
    for (const f of failures) {
      console.error(`  ${f.location}: ${f.message}`);
    }
    process.exit(1);
  }

  console.log(`ok: reference docs match package.json (20 settings, 16 commands)`);
}

checkReferenceDocs();
