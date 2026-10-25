/**
 * Validates that all relative markdown links and anchors resolve to existing files and headings.
 * Run: npx tsx scripts/check-doc-links.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

interface LinkCheckFailure {
  readonly file: string;
  readonly link: string;
  readonly reason: string;
}

const failures: LinkCheckFailure[] = [];

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === ".eval-cache"
      ) {
        continue;
      }
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function extractHeadings(content: string): Set<string> {
  const headings = new Set<string>();
  const lines = content.split("\n");
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (match) {
      const rawText = match[2].trim();
      // Strip any inline markdown link or formatting from heading text
      const cleanText = rawText.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "");
      headings.add(githubSlug(cleanText));
    }
  }
  return headings;
}

function checkFile(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const fileDir = path.dirname(filePath);
  let inCodeBlock = false;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }

    // Match markdown links: [text](target) but not images ![text](target)
    const linkRegex = /(?<!\!)\[([^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(line)) !== null) {
      const target = match[2].trim();

      // Skip external links, mailto, etc.
      if (
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:")
      ) {
        continue;
      }

      const [targetPath, anchor] = target.split("#");

      let resolvedFilePath: string;
      if (!targetPath) {
        // Internal anchor link in same file
        resolvedFilePath = filePath;
      } else {
        resolvedFilePath = path.resolve(fileDir, targetPath);
      }

      if (!fs.existsSync(resolvedFilePath)) {
        failures.push({
          file: path.relative(ROOT, filePath) + `:${lineNum + 1}`,
          link: target,
          reason: `Target file does not exist: ${path.relative(ROOT, resolvedFilePath)}`,
        });
        continue;
      }

      if (anchor) {
        const targetContent = fs.readFileSync(resolvedFilePath, "utf8");
        const headings = extractHeadings(targetContent);
        const expectedSlug = githubSlug(anchor);
        if (!headings.has(expectedSlug)) {
          failures.push({
            file: path.relative(ROOT, filePath) + `:${lineNum + 1}`,
            link: target,
            reason: `Anchor #${anchor} not found in ${path.relative(ROOT, resolvedFilePath)}`,
          });
        }
      }
    }
  }
}

function main(): void {
  const mdFiles: string[] = [
    path.join(ROOT, "README.md"),
    path.join(ROOT, "CHANGELOG.md"),
    ...findMarkdownFiles(path.join(ROOT, "docs")),
  ];

  if (fs.existsSync(path.join(ROOT, "SECURITY.md"))) {
    mdFiles.push(path.join(ROOT, "SECURITY.md"));
  }
  if (fs.existsSync(path.join(ROOT, "CONTRIBUTING.md"))) {
    mdFiles.push(path.join(ROOT, "CONTRIBUTING.md"));
  }

  for (const file of mdFiles) {
    checkFile(file);
  }

  if (failures.length > 0) {
    console.error(`FAIL: Found ${failures.length} broken doc link(s):`);
    for (const f of failures) {
      console.error(`  ${f.file} -> ${f.link} (${f.reason})`);
    }
    process.exit(1);
  }

  console.log(`ok: checked ${mdFiles.length} markdown files; all links and anchors resolve`);
}

main();
