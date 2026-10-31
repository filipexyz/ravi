import { Database, type DatabaseOptions } from "bun:sqlite";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class ProductionDatabaseError extends Error {
  readonly code = "PRODUCTION_DATABASE_REFUSED";
}

// Resolve existing ancestors too: a symlinked directory must not make a new
// database below production look like an isolated test database.
export function canonicalStatePath(input: string, depth = 0): string {
  if (depth > 40) throw new ProductionDatabaseError("State path has too many symlinks");
  const path = resolve(input);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // realpath cannot resolve a dangling file symlink. Inspect the link itself
    // before falling back to its parent, otherwise a new production DB escapes.
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return canonicalStatePath(resolve(dirname(path), readlinkSync(path)), depth + 1);
      }
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalStatePath(parent, depth + 1), relative(parent, path));
  }
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export interface DatabaseBoundaryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  argv?: string[];
}

/** Must run before mkdir, legacy file moves, opening SQLite, or cached reuse. */
export function assertDatabaseTargetAllowed(path: string, options: DatabaseBoundaryOptions = {}): void {
  if (path === ":memory:" || path === "") return;
  if (path.startsWith("file:")) throw new ProductionDatabaseError("Use a filesystem path, not a SQLite URI");
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const target = canonicalStatePath(path);
  const roots = [join(home, ".ravi")];
  // Optional extra production root; never replaces protection of ~/.ravi.
  if (env.RAVI_PRODUCTION_STATE_DIR) roots.push(env.RAVI_PRODUCTION_STATE_DIR);
  const productionRoot = roots.map((root) => canonicalStatePath(root)).find((root) => within(target, root));
  const legacy = target === canonicalStatePath(join(home, "ravi", "ravi.db"));

  // SQLite WAL files are path-based. Hardlinks are unsafe even outside the
  // protected root and can alias production under an innocent filename.
  try {
    if (statSync(target).nlink > 1) {
      throw new ProductionDatabaseError(`Refusing hardlinked state database: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!productionRoot && !legacy) return;

  const argv = options.argv ?? process.argv;
  const testing = env.NODE_ENV === "test" || argv.some((arg) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg));
  const confirmed = env.RAVI_CONFIRM_PRODUCTION_STATE_DIR;
  if (!testing && !legacy && confirmed && isAbsolute(confirmed) && canonicalStatePath(confirmed) === productionRoot) {
    return;
  }
  throw new ProductionDatabaseError(
    `Refusing production database: ${target}. Opening a writable handle can run destructive schema migrations. ` +
      "Set RAVI_STATE_DIR to an isolated directory for development/tests. " +
      (testing
        ? "Tests cannot confirm production access."
        : "A reviewed deployment must explicitly set RAVI_CONFIRM_PRODUCTION_STATE_DIR to the absolute production state directory."),
  );
}

/** All writable state database constructors go through this boundary. */
export function openStateDatabase(
  path: string,
  options?: DatabaseOptions,
  boundary?: DatabaseBoundaryOptions,
): Database {
  assertDatabaseTargetAllowed(path, boundary);
  return new Database(path, options);
}
