import { AppError, plan, summary, type Action, type Input } from './domain';

/** The public Ravi CLI preserves the app child context; stdout contains only the host result. */
export async function invokeApi(id: string, input: Record<string, unknown>, mutating: boolean) {
  if (mutating) throw new AppError('OMIE_READ_ONLY_HOST', 'Executor de consultas; escritas não habilitadas.');
  if (!process.env.RAVI_CONTEXT_KEY) throw new AppError('OMIE_IDENTITY_REQUIRED', 'Contexto-filho obrigatório.');
  const args = ['ravi', 'apps', 'run', 'omie-orders', 'host-read', '--json',
    '--', id, JSON.stringify(input)];
  const child = Bun.spawn(args, { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const [raw, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let result: any;
  try { result = JSON.parse(raw); } catch { throw new AppError('OMIE_HOST_TRANSPORT_FAILED', 'Resposta inválida do executor.'); }
  if (exit !== 0 || result?.ok !== true || !result.result || result.result.success !== true) {
    const candidate = result?.error?.code ?? result?.errorCode;
    const code = typeof candidate === 'string' && /^(OMIE_[A-Z0-9_]+|INVALID_INPUT)$/.test(candidate) ? candidate : 'OMIE_HOST_TRANSPORT_FAILED';
    throw new AppError(code, 'Executor recusou a consulta; nenhum detalhe sensível foi exposto.');
  }
  return result.result;
}
export async function invoke(action: Action, input: Input) {
  const p = plan(action, input);
  // The user-facing order client remains read-only during channel activation.
  // General API writes require an explicit preview/review digest and host approval.
  if (p.mutating) throw new AppError('OMIE_READ_ONLY_HOST', 'Executor de consultas; escritas não habilitadas.');
  const out = await invokeApi(`produtos/${p.endpoint}:${p.method}`, { params: p.param }, false);
  const data = out.data;
  if (action === 'list') return { success: true, items: data.pedido_venda_produto.map(summary), total: data.total_de_registros,
    pagination: { page: p.param.pagina, limit: p.param.registros_por_pagina, totalPages: data.total_de_paginas,
      nextPage: p.param.pagina < data.total_de_paginas ? p.param.pagina + 1 : null } };
  if (action === 'get') return { success: true, item: { ...summary(data.pedido_venda_produto), revision: out.revision },
    items: (data.pedido_venda_produto.det ?? []).map((d: any) => ({ code: d.produto?.codigo_produto, quantity: d.produto?.quantidade, unitPrice: d.produto?.valor_unitario })) };
  return { success: true, page: p.param.pagina, totalPages: data.total_de_paginas,
    items: (data.cadastros ?? []).filter((c: any) => c.cCodOperacao === '11').flatMap((c: any) => (c.etapas ?? []).map((e: any) => ({ code: e.cCodigo, description: e.cDescricao, inactive: e.cInativo === 'S' }))) };
}
