import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Exact bytes, no environment expansion, symlink or world/group-readable file. */
export async function readAuthSecretFile(path: string) {
  let file;
  try {
    if (!isAbsolute(path)) throw new Error();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size < 1 || stat.size > 32768 ||
      (process.getuid && ![0,process.getuid()].includes(stat.uid))) throw new Error();
    const value = await file.readFile("utf8");
    if (!value || value.includes("\0")) throw new Error();
    return value;
  } catch { throw new Error("Protected authentication secret is unavailable."); }
  finally { await file?.close(); }
}
