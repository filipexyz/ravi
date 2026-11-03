import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** Complete Vite artifact built from the Desktop repository; never a copied UI. */
export async function desktopAsset(name: string) {
  if (!/^(connected\.html|assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2?|svg|png))$/.test(name)) return null;
  const root = resolve(process.env.RAVI_DESKTOP_DIST ?? '.desktop');
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) return null;
  try {
    const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')) as { revision: string; files: Record<string, string> };
    if (!/^[a-f0-9]{40}$/.test(manifest.revision) || !manifest.files[name]) return null;
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]) return null;
    const extension = name.split('.').pop()!;
    const type: Record<string,string> = { html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',woff2:'font/woff2',woff:'font/woff',svg:'image/svg+xml',png:'image/png' };
    return new Response(new Uint8Array(bytes), {headers:{'content-type':type[extension]!, 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', 'x-ravi-desktop-revision':manifest.revision,
      ...(extension==='html' ? {'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"} : {})}});
  } catch { return null; }
}
