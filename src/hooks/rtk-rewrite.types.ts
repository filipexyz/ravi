export interface RtkRule {
  id: string;
  match: RegExp;
  rewrite: string;
}

export interface RtkRewriteConfig {
  rules: RtkRule[];
  rtkBinaryPath: string | null;
}
