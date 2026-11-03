import { getConsoleApiAuthState } from '@/lib/auth/session';
import { getConsoleWorkspace } from '@/server/console/workspace';
import { desktopAsset } from '@/server/console/desktop/artifact';
import { NextRequest, NextResponse } from 'next/server';
import { getOidcOrigin } from '@/lib/auth/oidc-config';
export const runtime = 'nodejs';
export async function GET(request:NextRequest, context:{params:Promise<{org:string}>}) {
  const auth=await getConsoleApiAuthState();
  if(!auth){const url=new URL('/login',getOidcOrigin());url.searchParams.set('returnTo',request.nextUrl.pathname);return NextResponse.redirect(url);}
  if(auth.mode!=='oidc')return new Response('Console sign-in required',{status:403});
  try {await getConsoleWorkspace(auth,{organizationRef:(await context.params).org});}
  catch{return new Response('Organization unavailable',{status:403,headers:{'cache-control':'no-store'}});}
  return await desktopAsset('connected.html') ?? new Response('Desktop build unavailable',{status:503,headers:{'cache-control':'no-store'}});
}
