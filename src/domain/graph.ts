import type { FileEntry, Relationship, SymbolDef } from "./model";
import { compareStrings } from "../shared/text";

export type NodeId = string; // "file:<path>" | "dir:<path>" | "symbol:<id>" | "external:<pkg>"

export interface GraphEdge {
  source: NodeId;
  target: NodeId;
  kind: string;
  provenance: string;
}

/**
 * In-memory relationship graph built from persisted index entries.
 *
 * All adjacency lists are kept sorted so any traversal order is deterministic
 * regardless of insertion order. The graph is rebuilt incrementally:
 * `upsertEntry` / `removeFile` update only the affected file's edges.
 */
export class RelationshipGraph {
  private readonly outgoing = new Map<NodeId, GraphEdge[]>();
  private readonly incoming = new Map<NodeId, GraphEdge[]>();
  private readonly fileEntries = new Map<string, FileEntry>();
  private readonly externalPackages = new Set<string>();

  /** Returns edges leaving a node, sorted deterministically. */
  edgesFrom(node: NodeId): GraphEdge[] {
    return [...(this.outgoing.get(node) ?? [])].sort(compareEdge);
  }

  /** Returns edges entering a node, sorted deterministically. */
  edgesTo(node: NodeId): GraphEdge[] {
    return [...(this.incoming.get(node) ?? [])].sort(compareEdge);
  }

  /** File-level dependencies (files this file imports from inside the repo). */
  fileDependencies(filePath: string): string[] {
    const targets: string[] = [];
    for (const e of this.edgesFrom(`file:${filePath}`)) {
      if (e.target.startsWith("file:")) targets.push(e.target.slice("file:".length));
    }
    return [...new Set(targets)].sort(compareStrings);
  }

  /** File-level dependents (repo files that import this file). */
  fileDependents(filePath: string): string[] {
    const sources: string[] = [];
    for (const e of this.edgesTo(`file:${filePath}`)) {
      if (e.source.startsWith("file:")) sources.push(e.source.slice("file:".length));
    }
    return [...new Set(sources)].sort(compareStrings);
  }

  /** All node ids that have at least one edge. */
  nodes(): NodeId[] {
    return [...new Set([...this.outgoing.keys(), ...this.incoming.keys()])].sort(compareStrings);
  }

  allExternalPackages(): string[] {
    return [...this.externalPackages].sort(compareStrings);
  }

  getEntry(filePath: string): FileEntry | undefined {
    return this.fileEntries.get(filePath);
  }

  allFiles(): string[] {
    return [...this.fileEntries.keys()].sort(compareStrings);
  }

  fileCount(): number {
    return this.fileEntries.size;
  }

  getSymbol(symbolId: string): SymbolDef | undefined {
    const filePath = symbolId.slice(0, symbolId.indexOf("#"));
    return this.fileEntries.get(filePath)?.symbols.find((s) => s.id === symbolId);
  }

  /** Replaces (or adds) the stored entry and re-derives its edges atomically. */
  upsertEntry(entry: FileEntry): void {
    this.removeFile(entry.meta.path);
    this.fileEntries.set(entry.meta.path, entry);
    this.indexEntry(entry);
  }

  removeFile(filePath: string): void {
    const existing = this.fileEntries.get(filePath);
    if (!existing) return;
    const fileNode = `file:${filePath}`;
    for (const edge of this.outgoing.get(fileNode) ?? []) {
      this.removeFromList(this.incoming, edge.target, edge);
    }
    for (const edge of this.incoming.get(fileNode) ?? []) {
      this.removeFromList(this.outgoing, edge.source, edge);
    }
    // Symbol-node edges also originate from this file's symbols.
    for (const sym of existing.symbols) {
      const symNode = `symbol:${sym.id}`;
      for (const edge of this.outgoing.get(symNode) ?? []) {
        this.removeFromList(this.incoming, edge.target, edge);
      }
      for (const edge of this.incoming.get(symNode) ?? []) {
        this.removeFromList(this.outgoing, edge.source, edge);
      }
      this.outgoing.delete(symNode);
      this.incoming.delete(symNode);
    }
    this.outgoing.delete(fileNode);
    this.incoming.delete(fileNode);
    this.fileEntries.delete(filePath);
  }

  clear(): void {
    this.outgoing.clear();
    this.incoming.clear();
    this.fileEntries.clear();
    this.externalPackages.clear();
  }

  private indexEntry(entry: FileEntry): void {
    const fileNode = `file:${entry.meta.path}`;
    const add = (source: NodeId, target: NodeId, kind: string, provenance: string) => {
      this.addEdge(source, target, kind, provenance);
    };

    // contains: file -> symbol (deterministic id order) and dir -> file
    const dir = entry.meta.path.includes("/")
      ? entry.meta.path.slice(0, entry.meta.path.lastIndexOf("/"))
      : "";
    if (dir) add(`dir:${dir}`, fileNode, "contains", "STATIC_EXACT");
    for (const sym of entry.symbols) {
      add(fileNode, `symbol:${sym.id}`, "contains", "STATIC_EXACT");
    }

    // imports edges are computed by the analysis layer and stored in
    // entry.internalRelations as file->file / file->external edges.
    for (const rel of entry.internalRelations) {
      add(rel.source, rel.target, rel.kind, rel.provenance);
    }
  }

  private addEdge(source: NodeId, target: NodeId, kind: string, provenance: string): void {
    const edge: GraphEdge = { source, target, kind, provenance };
    const out = this.outgoing.get(source) ?? [];
    if (!out.some((e) => e.target === target && e.kind === kind)) out.push(edge);
    this.outgoing.set(source, out);
    const inc = this.incoming.get(target) ?? [];
    if (!inc.some((e) => e.source === source && e.kind === kind)) inc.push(edge);
    this.incoming.set(target, inc);
    this.noteExternalAdded(source, target);
  }

  private removeFromList(map: Map<NodeId, GraphEdge[]>, key: NodeId, edge: GraphEdge): void {
    const list = map.get(key);
    if (!list) return;
    const idx = list.findIndex(
      (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind,
    );
    if (idx >= 0) {
      list.splice(idx, 1);
      // Only removals from an incoming list can retire an external package:
      // the incoming list of external:<pkg> holds every remaining reference.
      if (map === this.incoming) this.noteExternalRemoved(edge.target);
    }
    if (list.length === 0) map.delete(key);
  }

  /**
   * M3-hardening: the external-package set is maintained INCREMENTALLY on
   * edge add/remove instead of being re-derived from the whole graph after
   * every entry upsert (which made startup load O(N²) — the second-hot spot
   * in the M2 startup profile). The maintenance is scoped exactly like the
   * previous full derivation: only edges whose SOURCE is a file node count,
   * so the resulting set is byte-identical to a full scan (verified by the
   * fuzz test in graph.test.ts, which compares against a public-API oracle).
   */
  private noteExternalAdded(source: NodeId, target: NodeId): void {
    if (source.startsWith("file:") && target.startsWith("external:")) {
      this.externalPackages.add(target.slice("external:".length));
    }
  }

  private noteExternalRemoved(target: NodeId): void {
    if (!target.startsWith("external:")) return;
    const remaining = this.incoming.get(target) ?? [];
    if (!remaining.some((e) => e.source.startsWith("file:"))) {
      this.externalPackages.delete(target.slice("external:".length));
    }
  }
}

function compareEdge(a: GraphEdge, b: GraphEdge): number {
  const bySource = compareStrings(a.source, b.source);
  if (bySource !== 0) return bySource;
  const byTarget = compareStrings(a.target, b.target);
  if (byTarget !== 0) return byTarget;
  return compareStrings(a.kind, b.kind);
}

/**
 * Depth-limited deterministic breadth-first traversal. Visits neighbors in
 * sorted order and enforces a HARD depth limit, verified by tests even on
 * cyclic fixtures.
 */
export function traverse(
  graph: RelationshipGraph,
  startNodes: NodeId[],
  maxDepth: number,
  edgeFilter?: (edge: GraphEdge) => boolean,
): TraversalResult {
  const visited = new Set<NodeId>(startNodes);
  const depthOf = new Map<NodeId, number>(startNodes.map((n) => [n, 0] as const));
  const visitedEdges: GraphEdge[] = [];
  let frontier = [...startNodes].sort(compareStrings);

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: NodeId[] = [];
    for (const node of frontier) {
      for (const edge of graph.edgesFrom(node)) {
        if (edgeFilter && !edgeFilter(edge)) continue;
        visitedEdges.push(edge);
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        depthOf.set(edge.target, depth + 1);
        next.push(edge.target);
      }
    }
    frontier = next.sort(compareStrings);
    if (frontier.length === 0) break;
  }
  return { nodes: [...visited].sort(compareStrings), depthOf, edges: visitedEdges };
}

export interface TraversalResult {
  nodes: NodeId[];
  depthOf: Map<NodeId, number>;
  edges: GraphEdge[];
}

/**
 * Bidirectional depth-limited traversal for retrieval: expands both
 * dependencies and dependents around the seeds, respecting the same HARD
 * depth limit. Edge direction is preserved in the returned edges.
 */
export function traverseBidirectional(
  graph: RelationshipGraph,
  startNodes: NodeId[],
  maxDepth: number,
  edgeFilter?: (edge: GraphEdge) => boolean,
): TraversalResult {
  const visited = new Set<NodeId>(startNodes);
  const depthOf = new Map<NodeId, number>(startNodes.map((n) => [n, 0] as const));
  const visitedEdges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();
  let frontier = [...startNodes].sort(compareStrings);

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: NodeId[] = [];
    for (const node of frontier) {
      const candidates = [...graph.edgesFrom(node), ...graph.edgesTo(node)];
      candidates.sort(compareEdge);
      for (const edge of candidates) {
        if (edgeFilter && !edgeFilter(edge)) continue;
        const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
        if (!edgeSeen.has(key)) {
          edgeSeen.add(key);
          visitedEdges.push(edge);
        }
        const neighbor = edge.source === node ? edge.target : edge.source;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        depthOf.set(neighbor, depth + 1);
        next.push(neighbor);
      }
    }
    frontier = next.sort(compareStrings);
    if (frontier.length === 0) break;
  }
  return { nodes: [...visited].sort(compareStrings), depthOf, edges: visitedEdges };
}

/** Pure helper used by the analysis layer to express file-level relations. */
export function fileRelationsToGraph(list: Relationship[]): GraphEdge[] {
  return list.map((r) => ({
    source: r.source,
    target: r.target,
    kind: r.kind,
    provenance: r.provenance,
  }));
}
