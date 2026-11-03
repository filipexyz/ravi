import { getConsoleApiAuthState } from '@/lib/auth/session';
import { desktopAsset } from '@/server/console/desktop/artifact';
export const runtime = 'nodejs';
export async function GET(_request:Request,context:{params:Promise<{asset:string[]}>}) {
  const auth=await getConsoleApiAuthState();
  if(auth?.mode!=='oidc')return new Response(null,{status:401});
  const name=(await context.params).asset.join('/');
  if(!name.startsWith('assets/'))return new Response(null,{status:404});
  return await desktopAsset(name) ?? new Response(null,{status:404});
}
