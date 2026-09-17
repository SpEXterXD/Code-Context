import type { FileEntry } from "../domain/model";
import { compareStrings } from "../shared/text";

export interface StructureNode {
  name: string;
  path: string;
  isDir: boolean;
  children: StructureNode[];
  fileCount: number; // total files under this node
  language?: string;
}

/**
 * Builds a deterministic directory tree from indexed entries. Children are
 * always sorted (directories first, then files, lexicographic), so the same
 * repo state always renders the identical tree.
 */
export function buildProjectTree(entries: Map<string, FileEntry>): StructureNode {
  const root: StructureNode = { name: ".", path: "", isDir: true, children: [], fileCount: 0 };
  const dirs = new Map<string, StructureNode>([["", root]]);

  const ensureDir = (dirPath: string): StructureNode => {
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const slash = dirPath.lastIndexOf("/");
    const parent = slash === -1 ? "" : dirPath.slice(0, slash);
    const node: StructureNode = {
      name: dirPath.slice(slash + 1),
      path: dirPath,
      isDir: true,
      children: [],
      fileCount: 0,
    };
    ensureDir(parent).children.push(node);
    dirs.set(dirPath, node);
    return node;
  };

  for (const path of [...entries.keys()].sort(compareStrings)) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const entry = entries.get(path);
    ensureDir(dir).children.push({
      name: path.slice(slash + 1),
      path,
      isDir: false,
      children: [],
      fileCount: 1,
      language: entry?.meta.language,
    });
  }

  const computeCounts = (node: StructureNode): number => {
    if (!node.isDir) return 1;
    let total = 0;
    for (const child of node.children) total += computeCounts(child);
    node.fileCount = total;
    node.children.sort((a, b) =>
      a.isDir === b.isDir ? compareStrings(a.name, b.name) : a.isDir ? -1 : 1,
    );
    return total;
  };
  root.fileCount = computeCounts(root);
  return root;
}

export interface RenderTreeOptions {
  maxDepth: number;
  maxEntries: number;
}

export interface RenderedTree {
  text: string;
  truncated: boolean;
  renderedEntries: number;
}

/** Renders the ASCII tree with hard depth and entry-count limits. */
export function renderProjectTree(root: StructureNode, options: RenderTreeOptions): RenderedTree {
  const lines: string[] = ["."];
  let rendered = 0;
  let truncated = false;

  const walk = (node: StructureNode, prefix: string, depth: number): void => {
    if (depth >= options.maxDepth) {
      if (node.isDir && node.children.length > 0) {
        truncated = true;
      }
      return;
    }
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (rendered >= options.maxEntries) {
        truncated = true;
        return;
      }
      const last = i === node.children.length - 1;
      const connector = last ? "└── " : "├── ";
      const label = child.isDir
        ? `${child.name}/ (${child.fileCount} files)`
        : `${child.name} [${child.language ?? "generic"}]`;
      lines.push(`${prefix}${connector}${label}`);
      rendered++;
      walk(child, prefix + (last ? "    " : "│   "), depth + 1);
    }
  };

  walk(root, "", 0);
  return { text: lines.join("\n"), truncated, renderedEntries: rendered };
}
