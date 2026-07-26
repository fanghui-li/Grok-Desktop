/**
 * Session list → fork forest (pure tree build / flatten / visible slice).
 * DOM row paint stays in main.
 */

export type ThreadForestRow = {
  sessionId: string;
  updatedAt?: string;
  parentSessionId?: string;
};

export type ThreadTreeNode<T extends ThreadForestRow = ThreadForestRow> = {
  thread: T;
  children: ThreadTreeNode<T>[];
};

export function threadUpdatedAt(t: ThreadForestRow): string {
  return t.updatedAt ?? "";
}

export function subtreeMaxUpdated<T extends ThreadForestRow>(
  node: ThreadTreeNode<T>,
): string {
  let max = threadUpdatedAt(node.thread);
  for (const c of node.children) {
    const m = subtreeMaxUpdated(c);
    if (m > max) max = m;
  }
  return max;
}

/**
 * Flat list → forest: parent in same list → child; missing parent / cycle → root.
 */
export function buildThreadForest<T extends ThreadForestRow>(
  list: T[],
): ThreadTreeNode<T>[] {
  const byId = new Map(list.map((t) => [t.sessionId, t] as const));
  const childIds = new Set<string>();
  const childrenOf = new Map<string, T[]>();

  const wouldCycle = (childId: string, parentId: string): boolean => {
    let cur: string | undefined = parentId;
    const seen = new Set<string>();
    while (cur) {
      if (cur === childId) return true;
      if (seen.has(cur)) return true;
      seen.add(cur);
      const row = byId.get(cur);
      cur = row?.parentSessionId;
      if (cur && !byId.has(cur)) break;
    }
    return false;
  };

  for (const t of list) {
    const p = t.parentSessionId?.trim();
    if (
      p &&
      p !== t.sessionId &&
      byId.has(p) &&
      !wouldCycle(t.sessionId, p)
    ) {
      const arr = childrenOf.get(p) ?? [];
      arr.push(t);
      childrenOf.set(p, arr);
      childIds.add(t.sessionId);
    }
  }

  const sortByUpdated = (a: T, b: T) =>
    threadUpdatedAt(b).localeCompare(threadUpdatedAt(a));

  const buildNode = (t: T): ThreadTreeNode<T> => {
    const kids = (childrenOf.get(t.sessionId) ?? [])
      .slice()
      .sort(sortByUpdated)
      .map(buildNode);
    return { thread: t, children: kids };
  };

  return list
    .filter((t) => !childIds.has(t.sessionId))
    .map(buildNode)
    .sort((a, b) =>
      subtreeMaxUpdated(b).localeCompare(subtreeMaxUpdated(a)),
    );
}

export function flattenThreadForest<T extends ThreadForestRow>(
  forest: ThreadTreeNode<T>[],
): Array<{ thread: T; depth: number }> {
  const out: Array<{ thread: T; depth: number }> = [];
  const walk = (node: ThreadTreeNode<T>, depth: number) => {
    out.push({ thread: node.thread, depth });
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const n of forest) walk(n, 0);
  return out;
}

/** Preview: truncate by root count; fork children always follow parent. */
export function visibleThreadForest<T extends ThreadForestRow>(
  list: T[],
  showAll: boolean,
  limit: number,
): { flat: Array<{ thread: T; depth: number }>; rootCount: number } {
  const forest = buildThreadForest(list);
  const roots = showAll ? forest : forest.slice(0, limit);
  return { flat: flattenThreadForest(roots), rootCount: forest.length };
}
