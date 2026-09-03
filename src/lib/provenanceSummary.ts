/**
 * Phase 6 PR-C: Provenance Intelligence.
 *
 * Pure, deterministic derivation of a claim-level provenance summary from
 * already human-reviewed durable data (claim_sources + source_relationships).
 * NO AI call happens anywhere in this file or any of its callers -- every
 * field below is computed from rows a human already approved, edited, or
 * manually created via the existing analyse_provenance review workflow
 * (src/db/mutations/sourceRelationshipReviews.ts) or the manual provenance
 * form (src/db/mutations/provenance.ts). This module has no database
 * access of its own; the caller (src/db/queries/admin/index.ts) is
 * responsible for supplying an already claim-scoped, both-endpoints-
 * attached row set (see getClaimScopedSourceRelationships).
 *
 * ============================================================
 * WHY THIS FILE EXISTS (do not weaken these without product sign-off)
 * ============================================================
 *
 * analyse_provenance is POSITIVE-EDGE-ONLY: the AI never asserts "these two
 * sources are unrelated," only "here is a relationship I found a basis
 * for." Combined with the fact that most admins will only review the
 * handful of edges the AI actually proposed (or a small number added
 * manually), this means: A MISSING RELATIONSHIP ROW BETWEEN TWO ATTACHED
 * SOURCES MEANS NOTHING. It is not evidence of independence, it is not
 * evidence of an unreviewed pair having been checked and found empty --
 * it is simply absence of data. Every field in this module is named and
 * documented to make that distinction impossible to miss:
 *
 *   - "reviewedGraphRootIds" means only "root of the graph AS CURRENTLY
 *     REVIEWED" -- never "proven real-world original source."
 *   - "internalGraphTouchState" describes only whether every attached
 *     SOURCE has been touched by at least one reviewed relationship --
 *     it is explicitly NOT a claim that every POSSIBLE PAIR has been
 *     reviewed, and "all_sources_touched" is fully compatible with
 *     connectedComponentCount > 1 (two internally-well-reviewed clusters
 *     that were never compared against each other at all).
 *   - "possibleInternalPairCount" is informational only. NEVER compute or
 *     display a "review completion percentage" from it -- the schema has
 *     no way to assert "these two sources are confirmed unrelated," so
 *     most possible pairs are expected to stay unreviewed forever without
 *     that being a defect.
 *
 * ============================================================
 * NORMALIZATION (locked)
 * ============================================================
 *
 * Every raw source_relationships row is first bucketed into exactly one
 * semantic category, based on relationshipType alone:
 *
 *   dependency:  original, citation, repetition, derivative, aggregation
 *   independent: independent_corroboration
 *   unknown:     unknown
 *
 * Rows in the "dependency" category are then normalized into a directed
 * ORIGIN -> DEPENDENT edge. This is the ONE place the database's unusual
 * `original` orientation (see src/lib/provenanceDirection.ts) is handled;
 * every algorithm below operates only on normalized edges and never
 * re-examines relationshipType again except for the raw diagnostic tally.
 *
 *   (A, B, citation)    "A cites B"                => B -> A
 *   (A, B, repetition)  "A repeats B"               => B -> A
 *   (A, B, derivative)  "A derives from B"          => B -> A
 *   (A, B, aggregation) "A aggregates B"             => B -> A
 *   (A, B, original)    "A is the original source for B" => A -> B
 *
 * "independent" and "unknown" rows are never inserted into the directed
 * dependency graph -- they become unordered pair-level assertions.
 *
 * ============================================================
 * CONFLICT SEMANTICS (locked)
 * ============================================================
 *
 * For each UNORDERED pair {X, Y} with >=1 in-scope reviewed row, look at
 * the SET of semantic categories present (not the set of raw relationship
 * types):
 *
 *   - Exactly one category present  -> NOT conflicted.
 *       - "dependency" only: multiple types in the SAME normalized
 *         direction merge into one semantic edge (raw type counts are
 *         still tallied diagnostically); OPPOSING normalized directions
 *         both enter the graph as separate edges -- this is a real 2-node
 *         cycle, never a conflict, and neither direction is silently
 *         preferred.
 *       - "independent" only: both raw storage directions of
 *         independent_corroboration collapse into one unordered pair.
 *       - "unknown" only: one unordered "unknown" pair.
 *   - Two or more categories present -> CONFLICTED. Excluded from the
 *     dependency graph, from independentPairCount/independentSourceIds,
 *     from unknownPairCount, and from connected-component edges. Still
 *     counted in reviewedInternalPairCount, in
 *     sourcesWithReviewedInternalRelationship participation, in
 *     conflictedPairCount/conflictedPairs, and in the raw diagnostic
 *     type tally where the row's own category is "dependency". No
 *     precedence is ever guessed.
 *
 * ============================================================
 * GRAPH SHAPE (locked)
 * ============================================================
 *
 * Node set for BOTH root/cycle detection and connected-component analysis
 * is ALWAYS every source item attached to the claim -- an attached source
 * with zero reviewed relationships is its own singleton component, and
 * can never be a root (a root must have >=1 outgoing valid dependency
 * edge).
 *
 * connectedComponentCount edges: valid (non-conflicted) dependency
 * semantic edges (treated as UNDIRECTED for this purpose only),
 * valid independent pairs, valid unknown pairs. Conflicted pairs are
 * EXCLUDED from connectivity -- once a pair's reviewed state is
 * self-contradictory, it must not silently re-enter a structural
 * conclusion through component connectivity, unlike a valid "unknown"
 * pair, which is one coherent (if inconclusive) reviewed classification.
 *
 * hasCycles runs ONLY over the valid DIRECTED dependency graph (post
 * conflict exclusion). Opposing normalized directions between the same
 * two sources are, by construction, a 2-node cycle.
 */

export type SourceRelationshipType =
  | "original"
  | "independent_corroboration"
  | "citation"
  | "repetition"
  | "aggregation"
  | "derivative"
  | "unknown";

type SemanticCategory = "dependency" | "independent" | "unknown";

const DEPENDENCY_RELATIONSHIP_TYPES = ["citation", "repetition", "derivative", "aggregation", "original"] as const;

/**
 * The exact row shape this module needs -- deliberately narrower than the
 * full source_relationships row (no id/confidence/evidenceNote/createdAt):
 * this function only ever needs to know WHICH two source items and WHICH
 * relationship type. The caller is responsible for ensuring every row
 * passed here already has BOTH endpoints attached to the one claim being
 * summarized (see getClaimScopedSourceRelationships) -- this module
 * additionally defends against that invariant defensively (see
 * computeClaimProvenanceSummary's filtering step below), but does not
 * itself know how to query for it.
 */
export interface ClaimScopedSourceRelationshipRow {
  sourceItemIdA: number;
  sourceItemIdB: number;
  relationshipType: SourceRelationshipType;
}

export interface ConflictedPair {
  /** The smaller of the two source item ids -- canonical unordered-pair form. */
  sourceItemIdX: number;
  /** The larger of the two source item ids. */
  sourceItemIdY: number;
  /** Deterministic order: dependency, then independent, then unknown -- whichever are present. */
  categoriesPresent: SemanticCategory[];
}

export interface ClaimProvenanceSummary {
  claimId: number;

  // ---- SOURCE-level facts (unit: distinct source_items.id) --------------
  totalAttachedSources: number;
  sourcesWithReviewedInternalRelationship: number;
  sourcesWithoutReviewedInternalRelationship: number;
  /** Ascending order. See module header: means ONLY "root of the currently
   *  reviewed dependency graph," never "proven real-world original source." */
  reviewedGraphRootIds: number[];
  /** Ascending order. Distinct sources participating in >=1 valid
   *  independent pair -- never double-counted. */
  independentSourceIds: number[];
  /** See module header for the exact, deliberately limited meaning of
   *  "all_sources_touched". */
  internalGraphTouchState: "none" | "some" | "all_sources_touched";

  // ---- PAIR-level facts (unit: distinct UNORDERED source-item pairs) ----
  /** C(totalAttachedSources, 2). Informational only -- see module header;
   *  never derive a completion percentage from this. */
  possibleInternalPairCount: number;
  /** Distinct unordered pairs with >=1 in-scope reviewed row of ANY kind,
   *  INCLUDING conflicted pairs (a conflicted pair is still "reviewed,"
   *  just ambiguously). */
  reviewedInternalPairCount: number;
  /** Distinct unordered pairs whose reviewed row(s) are ALL category
   *  "independent" (never conflicted). Both raw storage directions of the
   *  same pair count once. */
  independentPairCount: number;
  /** Distinct unordered pairs whose reviewed row(s) are ALL category
   *  "unknown" (never conflicted). */
  unknownPairCount: number;
  /** Distinct unordered pairs whose reviewed rows span >=2 semantic
   *  categories. */
  conflictedPairCount: number;
  /** Ascending order by (sourceItemIdX, sourceItemIdY). */
  conflictedPairs: ConflictedPair[];

  // ---- DEPENDENCY EDGE facts (unit: distinct DIRECTED origin->dependent
  //      pairs, post-normalization, EXCLUDING conflicted pairs) ----------
  /** Distinct (origin, dependent) directed pairs with >=1 valid dependency
   *  row, after merging same-direction multi-type rows into one edge.
   *  Opposing-direction rows between the same two sources count as 2 (a
   *  cycle, not a merge). */
  dependencySemanticEdgeCount: number;
  /** RAW row counts per relationshipType, in-scope, INCLUDING rows that
   *  belong to a conflicted pair -- a literal tally of durable facts,
   *  never a semantic conclusion. Will not necessarily match
   *  dependencySemanticEdgeCount. */
  rawDependencyRelationshipTypeCounts: {
    citation: number;
    repetition: number;
    derivative: number;
    aggregation: number;
    original: number;
  };

  // ---- GRAPH SHAPE --------------------------------------------------------
  connectedComponentCount: number;
  hasCycles: boolean;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function canonicalPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function categorize(relationshipType: SourceRelationshipType): SemanticCategory {
  if (relationshipType === "independent_corroboration") return "independent";
  if (relationshipType === "unknown") return "unknown";
  return "dependency";
}

/** Normalizes one dependency-category row into its origin->dependent directed
 * edge. Must only be called for rows whose category is "dependency" -- see
 * module header for the exact per-type mapping. */
function normalizeDependencyEdge(row: ClaimScopedSourceRelationshipRow): { origin: number; dependent: number } {
  if (row.relationshipType === "original") {
    return { origin: row.sourceItemIdA, dependent: row.sourceItemIdB };
  }
  // citation, repetition, derivative, aggregation: the subject (A) depends
  // on the object (B), so the normalized edge points object -> subject.
  return { origin: row.sourceItemIdB, dependent: row.sourceItemIdA };
}

/** Plain union-find, internal to this module -- never exposed. */
class UnionFind {
  private readonly parent = new Map<number, number>();

  constructor(nodes: number[]) {
    for (const n of nodes) this.parent.set(n, n);
  }

  find(x: number): number {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent.set(rx, ry);
  }

  countComponents(): number {
    const roots = new Set<number>();
    for (const n of this.parent.keys()) roots.add(this.find(n));
    return roots.size;
  }
}

/** Directed-cycle detection via standard white/gray/black DFS coloring. */
function directedGraphHasCycle(nodes: number[], edges: Array<{ origin: number; dependent: number }>): boolean {
  const adjacency = new Map<number, number[]>();
  for (const n of nodes) adjacency.set(n, []);
  for (const e of edges) {
    const list = adjacency.get(e.origin);
    if (list) list.push(e.dependent);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();
  for (const n of nodes) color.set(n, WHITE);

  function visit(node: number): boolean {
    color.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next);
      if (nextColor === GRAY) return true; // back-edge -> cycle
      if (nextColor === WHITE && visit(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE && visit(n)) return true;
  }
  return false;
}

/**
 * Computes the deterministic claim-level provenance summary.
 *
 * @param claimId The anchor claim id, carried through to the output only.
 * @param attachedSourceItemIds Every source item attached to this claim via
 *   claim_sources (the full node set -- includes sources with zero
 *   relationships, which become singleton components and can never be roots).
 * @param relationships Already claim-scoped rows (see
 *   getClaimScopedSourceRelationships) -- this function additionally
 *   filters defensively to rows whose BOTH endpoints are in
 *   attachedSourceItemIds, so a caller bug upstream cannot leak an
 *   external relationship into the computed summary.
 */
export function computeClaimProvenanceSummary(
  claimId: number,
  attachedSourceItemIds: number[],
  relationships: ClaimScopedSourceRelationshipRow[]
): ClaimProvenanceSummary {
  const attachedSet = new Set(attachedSourceItemIds);
  const nodes = [...attachedSet].sort((a, b) => a - b);
  const totalAttachedSources = nodes.length;

  // Defense in depth: never let a row with an endpoint outside this
  // claim's own attached set influence anything below, even if the
  // caller's query had a bug. This mirrors getInClusterLinksForCluster's
  // own "defense in depth alongside the query-level filter" pattern.
  const inScopeRelationships = relationships.filter(
    (r) => attachedSet.has(r.sourceItemIdA) && attachedSet.has(r.sourceItemIdB)
  );

  // ---- group all in-scope rows by unordered pair -------------------------
  const groups = new Map<string, { x: number; y: number; rows: ClaimScopedSourceRelationshipRow[] }>();
  for (const row of inScopeRelationships) {
    const [x, y] = canonicalPair(row.sourceItemIdA, row.sourceItemIdB);
    const key = pairKey(x, y);
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { x, y, rows: [row] });
  }

  const participatingSourceIds = new Set<number>();
  const conflictedPairs: ConflictedPair[] = [];
  const validDependencyEdges = new Map<string, { origin: number; dependent: number }>();
  const independentPairKeys = new Set<string>();
  const independentSourceIds = new Set<number>();
  const unknownPairKeys = new Set<string>();
  const connectivityUnion = new UnionFind(nodes);

  const rawDependencyRelationshipTypeCounts = {
    citation: 0,
    repetition: 0,
    derivative: 0,
    aggregation: 0,
    original: 0,
  };

  for (const { x, y, rows } of groups.values()) {
    participatingSourceIds.add(x);
    participatingSourceIds.add(y);

    // Raw diagnostic tally: every in-scope dependency-category row counts
    // here, regardless of whether this pair turns out conflicted.
    for (const row of rows) {
      if (categorize(row.relationshipType) === "dependency") {
        rawDependencyRelationshipTypeCounts[row.relationshipType as (typeof DEPENDENCY_RELATIONSHIP_TYPES)[number]] += 1;
      }
    }

    const categoriesPresent = new Set<SemanticCategory>();
    for (const row of rows) categoriesPresent.add(categorize(row.relationshipType));

    if (categoriesPresent.size > 1) {
      // CONFLICTED -- excluded from dependency graph, independent/unknown
      // pair counts, and connectivity. Still counted in
      // reviewedInternalPairCount (via `groups`) and participation (above).
      const ordered: SemanticCategory[] = (["dependency", "independent", "unknown"] as const).filter((c) =>
        categoriesPresent.has(c)
      );
      conflictedPairs.push({ sourceItemIdX: x, sourceItemIdY: y, categoriesPresent: ordered });
      continue;
    }

    const [onlyCategory] = categoriesPresent;

    if (onlyCategory === "dependency") {
      for (const row of rows) {
        const edge = normalizeDependencyEdge(row);
        const edgeKey = `${edge.origin}:${edge.dependent}`;
        validDependencyEdges.set(edgeKey, edge);
      }
      connectivityUnion.union(x, y);
    } else if (onlyCategory === "independent") {
      independentPairKeys.add(pairKey(x, y));
      independentSourceIds.add(x);
      independentSourceIds.add(y);
      connectivityUnion.union(x, y);
    } else {
      // onlyCategory === "unknown"
      unknownPairKeys.add(pairKey(x, y));
      connectivityUnion.union(x, y);
    }
  }

  const dependencyEdgeList = [...validDependencyEdges.values()];

  // ---- roots: origin of >=1 valid edge, dependent of zero valid edges ----
  const hasOutgoing = new Set<number>();
  const hasIncoming = new Set<number>();
  for (const e of dependencyEdgeList) {
    hasOutgoing.add(e.origin);
    hasIncoming.add(e.dependent);
  }
  const reviewedGraphRootIds = [...hasOutgoing].filter((id) => !hasIncoming.has(id)).sort((a, b) => a - b);

  const hasCycles = directedGraphHasCycle(nodes, dependencyEdgeList);
  const connectedComponentCount = connectivityUnion.countComponents();

  const sourcesWithReviewedInternalRelationshipCount = participatingSourceIds.size;
  const sourcesWithoutReviewedInternalRelationshipCount = totalAttachedSources - sourcesWithReviewedInternalRelationshipCount;

  let internalGraphTouchState: ClaimProvenanceSummary["internalGraphTouchState"];
  if (sourcesWithReviewedInternalRelationshipCount === 0) internalGraphTouchState = "none";
  else if (sourcesWithReviewedInternalRelationshipCount === totalAttachedSources) internalGraphTouchState = "all_sources_touched";
  else internalGraphTouchState = "some";

  const possibleInternalPairCount = (totalAttachedSources * (totalAttachedSources - 1)) / 2;

  return {
    claimId,
    totalAttachedSources,
    sourcesWithReviewedInternalRelationship: sourcesWithReviewedInternalRelationshipCount,
    sourcesWithoutReviewedInternalRelationship: sourcesWithoutReviewedInternalRelationshipCount,
    reviewedGraphRootIds,
    independentSourceIds: [...independentSourceIds].sort((a, b) => a - b),
    internalGraphTouchState,
    possibleInternalPairCount,
    reviewedInternalPairCount: groups.size,
    independentPairCount: independentPairKeys.size,
    unknownPairCount: unknownPairKeys.size,
    conflictedPairCount: conflictedPairs.length,
    conflictedPairs: conflictedPairs.sort((a, b) => a.sourceItemIdX - b.sourceItemIdX || a.sourceItemIdY - b.sourceItemIdY),
    dependencySemanticEdgeCount: dependencyEdgeList.length,
    rawDependencyRelationshipTypeCounts,
    connectedComponentCount,
    hasCycles,
  };
}
