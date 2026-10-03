/**
 * dirUsage.ts: what a participant-written directory holds, measured without trusting it (issue #214).
 *
 * Two environment paths walk directories a participant controls: the epoch-start snapshot of the
 * agent's state directory (agentState.ts) and the per-block watch on what an agent has written
 * (agentDisk.ts). Both need the same three facts -- how many bytes, how many entries, and whether
 * anything in there is not a plain file or directory -- and both need them bounded, because the
 * directory may have been built to make the measurement itself expensive.
 *
 * Measured 2026-10-02 (Node 23.5, APFS) before this existed: `fs.cpSync` over a tree holding one
 * FIFO threw ERR_INTERNAL_ASSERTION after first materialising a 1 GiB sparse file as 1 GiB of real
 * bytes, and a `filter` that admits only regular files still materialised the sparse file. So the
 * walk reports *apparent* bytes (what a copy writes) next to *allocated* bytes (what the disk
 * holds), and it is the caller's cap on the apparent size that keeps a sparse file out of a
 * snapshot -- the filter alone cannot.
 */
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, relative } from "node:path";

export type TreeLimits = {
  /** Stop walking past this many entries (files + directories). The totals are then a lower bound. */
  maxEntries: number;
  /** Directories deeper than this below the root are not entered. */
  maxDepth: number;
};

export type TreeUsage = {
  /** Sum of regular-file sizes as lstat reports them: what copying the tree would write. */
  apparentBytes: number;
  /** Sum of allocated 512-byte blocks: what the filesystem actually holds (0 for a sparse file). */
  allocatedBytes: number;
  /** Regular files and directories seen, root excluded. */
  entries: number;
  /** Deepest directory level entered, the root being 0. */
  depth: number;
  /** True when the walk stopped at a limit: every total above is a lower bound. */
  truncated: boolean;
  /** Entries that are neither a regular file nor a directory (first few; the count is `irregularCount`). */
  irregular: Array<{ path: string; kind: string }>;
  irregularCount: number;
  /** Set when the root itself could not be read. */
  error?: string;
};

const IRREGULAR_REPORTED = 8;

function kindOf(st: Stats): string {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice()) return "character-device";
  if (st.isBlockDevice()) return "block-device";
  return "other";
}

/**
 * Walk `root` with lstat (never following symlinks), stopping at the limits. Never throws: a
 * directory that cannot be read is reported in `error` and counted as irregular where it sits.
 */
export function measureTree(root: string, limits: TreeLimits): TreeUsage {
  const usage: TreeUsage = {
    apparentBytes: 0,
    allocatedBytes: 0,
    entries: 0,
    depth: 0,
    truncated: false,
    irregular: [],
    irregularCount: 0,
  };
  const irregular = (path: string, kind: string): void => {
    usage.irregularCount++;
    if (usage.irregular.length < IRREGULAR_REPORTED)
      usage.irregular.push({ path: relative(root, path) || ".", kind });
  };
  // Iterative, so a deep tree cannot turn the walk into a stack overflow.
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if (dir === root)
        usage.error = error instanceof Error ? error.message : String(error);
      else irregular(dir, "unreadable-directory");
      continue;
    }
    for (const name of names) {
      if (usage.entries >= limits.maxEntries) {
        usage.truncated = true;
        return usage;
      }
      const path = join(dir, name);
      let st: Stats;
      try {
        st = lstatSync(path);
      } catch {
        irregular(path, "unstatable");
        continue;
      }
      usage.entries++;
      if (st.isFile()) {
        usage.apparentBytes += st.size;
        usage.allocatedBytes += st.blocks * 512;
      } else if (st.isDirectory()) {
        const below = depth + 1;
        if (below > usage.depth) usage.depth = below;
        if (below > limits.maxDepth) {
          usage.truncated = true;
          continue;
        }
        stack.push({ dir: path, depth: below });
      } else {
        irregular(path, kindOf(st));
      }
    }
  }
  return usage;
}

/** The larger of what a copy would write and what the disk holds: the figure a quota is held to. */
export function bytesOnDisk(usage: TreeUsage): number {
  return Math.max(usage.apparentBytes, usage.allocatedBytes);
}

/** A `cpSync` filter that admits regular files and directories only (lstat: a symlink is refused, not followed). */
export function regularEntriesOnly(src: string): boolean {
  try {
    const st = lstatSync(src);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}
