import { Database, type DatabaseOptions } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
  modulePath?: string;
}

/** Trust the code's location, never cwd or argv claiming to be a daemon. */
function isDevelopmentCode(modulePath: string): boolean {
  let dir = dirname(canonicalStatePath(modulePath));
  while (true) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (pkg.name === "ravi.bot") {
        return existsSync(join(dir, "src")) || existsSync(join(dir, ".git"));
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return true; // Unknown provenance is not a deployment.
    dir = parent;
  }
}

const developmentCode = isDevelopmentCode(fileURLToPath(import.meta.url));

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
  const development = options.modulePath ? isDevelopmentCode(options.modulePath) : developmentCode;
  const confirmed = env.RAVI_CONFIRM_PRODUCTION_STATE_DIR;
  if (
    !testing &&
    !development &&
    !legacy &&
    confirmed &&
    isAbsolute(confirmed) &&
    canonicalStatePath(confirmed) === productionRoot
  ) {
    return;
  }
  throw new ProductionDatabaseError(
    `Refusing production database: ${target}. Opening a writable handle can run destructive schema migrations. ` +
      "Set RAVI_STATE_DIR to an isolated directory for development/tests. " +
      (testing
        ? "Tests cannot confirm production access."
        : development
          ? "Source checkouts, builds and worktrees cannot confirm production access, even with an inherited confirmation. Use an installed release for production."
          : `Before installing this release, set RAVI_CONFIRM_PRODUCTION_STATE_DIR=${productionRoot} in the PM2 ecosystem env of BOTH ravi and ravi-channels; apply it to the existing launchers with --update-env and persist with pm2 save. If already installed in the wrong order, reinstall the previous release first, restore service, then configure both launchers before retrying.`),
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
