/**
 * Assets importados como texto pelo bundle (`bun build --target bun`).
 *
 * O wrapper de detach é um script de shell de verdade — shellcheck e leitura
 * humano-legível importam — e precisa viajar dentro do bundle.
 */
declare module "*.sh" {
  const source: string;
  export default source;
}
