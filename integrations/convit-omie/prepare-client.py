#!/usr/bin/env python3
"""Prepare a reviewable candidate app tree. Never modifies the installed app or grants authority."""
import argparse, json, shutil
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('source', type=Path)
p.add_argument('output', type=Path)
a = p.parse_args()
if a.output.exists(): raise SystemExit('Output must not exist')
source = a.source.resolve()
manifest = json.loads((source / 'ravi.app.json').read_text())
if manifest['id'] != 'convit-omie': raise SystemExit('Unexpected app')
text = (source / 'api/cli.ts').read_text()
start = text.find('  // There is no supported provider-action gateway')
end = text.find('\n}', start)
if start < 0 or end < 0 or 'OMIE_HOST_ADAPTER_REQUIRED' not in text[start:end]: raise SystemExit('Client changed; review manually')
shutil.copytree(source, a.output, ignore=shutil.ignore_patterns('state', '*.sqlite*', '.env*', 'node_modules', 'last-denial.json'))
shutil.copyfile(Path(__file__).parent / 'bridge.ts', a.output / 'bridge.ts')
text = "import { invokeApi } from '../bridge';\n" + text[:start] + "  return invokeApi(op.id, input, op.classification !== 'read');" + text[end:]
(a.output / 'api/cli.ts').write_text(text)
policy = a.output / 'host/app-policy.ts'
policy_text = policy.read_text()
needle = 'ctx.surface.id === SCOPE.canonicalChat'
if policy_text.count(needle) != 1: raise SystemExit('Policy changed; review manually before activation')
policy.write_text(policy_text.replace(needle, 'typeof ctx.surface.id === \"string\"'))

for mode in ['read']:
 manifest['operations']['convit-omie.host-' + mode] = {
  'interface':'builtin', 'handler':'apps.convit-omie.' + mode, 'mutating':mode == 'write',
  'permission':('execute' if mode == 'write' else 'use') + ':app:convit-omie',
  'description':'Protected host transport; real runtime identity and channel membership required.'}
# Delegation requests, never grants. Live caller and executor must already hold each capability.
required=['execute:group:apps','use:app:convit-omie',
          'use:credential:omie:convit-pedidos',
          'use:credential:slack:cassia-slack','execute:slack:conversations.members']
operations=json.loads((Path(__file__).parents[2]/'src/apps/convit-omie/operations.json').read_text())
operations=[op for op in operations if op['classification']=='read']
required += [op['permission'] for op in operations] + ['execute:omie:'+op['id'] for op in operations]
manifest['context']['allow']=sorted(set(manifest['context'].get('allow',[])+required))
(a.output/'ravi.app.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'prepared':True,'installed':False,'output':str(a.output),'permissionsGranted':False}))
