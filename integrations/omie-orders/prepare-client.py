#!/usr/bin/env python3
"""Prepare a reviewable candidate app tree. Never modifies the installed app or grants authority."""
import argparse, json, shutil
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('source', type=Path)
p.add_argument('output', type=Path)
p.add_argument('--scope-file', required=True, type=Path)
a = p.parse_args()
if a.output.exists(): raise SystemExit('Output must not exist')
source = a.source.resolve()
if a.scope_file.resolve().is_relative_to(source): raise SystemExit('Private scope must stay outside the app source')
scope=json.loads(a.scope_file.read_text())
# LEGACY (remove 2027-01-31, same as src/apps/omie-orders/legacy-scope.ts): the first scope shape had no channelType.
LEGACY_KEYS = {'app','account','channel','canonicalChat','executor','connection','slackConnection'}
if set(scope) == LEGACY_KEYS:
 scope = {**{k: v for k, v in scope.items() if k != 'slackConnection'}, 'channelType': 'slack', 'channelConnection': scope['slackConnection']}
if set(scope) != {'app','channelType','account','channel','canonicalChat','executor','connection','channelConnection'} or scope.get('app') != 'omie-orders' or any(not isinstance(scope.get(k),str) or not scope[k] for k in ['channelType','account','channel','canonicalChat','executor','connection','channelConnection']):
  raise SystemExit('Valid private host scope required')
# What each channel adapter asks per call (its membership read). Mirrors the adapter's `capabilities(scope)`.
CHANNEL_CAPABILITIES = {
 'slack': lambda s: ['use:credential:slack:'+s['channelConnection'], 'execute:slack:conversations.members'],
}
if scope['channelType'] not in CHANNEL_CAPABILITIES: raise SystemExit('No adapter capabilities known for this channel type')
manifest = json.loads((source / 'ravi.app.json').read_text())
if manifest['id'] != 'omie-orders': raise SystemExit('Unexpected app')
text = (source / 'api/cli.ts').read_text()
start = text.find('  // There is no supported provider-action gateway')
end = text.find('\n}', start)
if start < 0 or end < 0 or 'OMIE_HOST_ADAPTER_REQUIRED' not in text[start:end]: raise SystemExit('Client changed; review manually')
if any(path.is_symlink() for path in source.rglob('*')): raise SystemExit('Symlinks are not allowed in candidate input')
shutil.copytree(source, a.output, ignore=shutil.ignore_patterns('state', '.git', '.ravi', '__pycache__', '*.db*', '*.sqlite*', '.env*', 'node_modules', 'last-denial.json'))
shutil.copyfile(Path(__file__).parent / 'bridge.ts', a.output / 'bridge.ts')
text = "import { invokeApi } from '../bridge';\n" + text[:start] + "  return invokeApi(op.id, input, op.classification !== 'read');" + text[end:]
(a.output / 'api/cli.ts').write_text(text)
policy = a.output / 'host/app-policy.ts'
policy_text = policy.read_text()
needle = 'ctx.surface.id === SCOPE.canonicalChat'
if policy_text.count(needle) != 1: raise SystemExit('Policy changed; review manually before activation')
policy.write_text(policy_text.replace(needle, 'typeof ctx.surface.id === \"string\"'))

for mode in ['read']:
 manifest['operations']['omie-orders.host-' + mode] = {
  'interface':'builtin', 'handler':'apps.omie-orders.' + mode, 'mutating':mode == 'write',
  'permission':('execute' if mode == 'write' else 'use') + ':app:omie-orders',
  'description':'Protected host transport; real runtime identity and channel membership required.'}
# Delegation requests, never grants. Live caller and executor must already hold each capability.
required=['mutate:apps:run','mutate:apps.run:*','execute:group:apps_run','execute:group:apps','use:app:omie-orders',
          'use:credential:omie:'+scope['connection'],
          ]+CHANNEL_CAPABILITIES[scope['channelType']](scope)
operations=json.loads((Path(__file__).parents[2]/'src/apps/omie-orders/operations.json').read_text())
operations=[op for op in operations if op['classification']=='read']
required += [op['permission'] for op in operations] + ['execute:omie:'+op['id'] for op in operations]
manifest['context']['allow']=sorted(set(manifest['context'].get('allow',[])+required))
(a.output/'ravi.app.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'prepared':True,'installed':False,'output':str(a.output),'permissionsGranted':False}))
