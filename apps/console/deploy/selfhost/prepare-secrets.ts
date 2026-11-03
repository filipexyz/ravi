import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Generates runtime secret files, not source configuration. Never logs secret data.
const root = join(import.meta.dir, ".private");
function put(name: string, content: string) {
  const path = join(root, name);
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
}
function env(name: string, values: Record<string, string>) {
  put(name, Object.entries(values).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n");
}
const secret = () => randomBytes(32).toString("hex");
function pair() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" } });
}
function command(args: string[]) {
  const result = spawnSync("openssl", args, { stdio: "ignore" });
  if (result.status !== 0) throw new Error("tls_generation_failed");
}
try {
  if (existsSync(root)) throw new Error("private_directory_already_exists_refuse_regeneration");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root,"tls"), { mode: 0o700 });
  // This installation excludes Pages AI. Do not read any provider credential.
  const db = { postgres: secret(), console: secret(), workflow: secret(), keycloak: secret() };
  const clients = { console: secret(), executor: secret() };
  const accessKey = "staging" + randomBytes(12).toString("hex");
  const s3secret = secret();
  const pagesControl = secret();
  const delegation = pair(), callback = pair(), assertion = pair();
  const issuer = "https://idp.nba-console.test/realms/console-staging";
  const org = "00000000-0000-4000-8000-000000000001";
  const roles = ["owner", "developer", "viewer", "outsider"] as const;
  const users = roles.map((role, i) => ({
    role, name: `Staging ${role}`, email: `${role}@staging.invalid`,
    id: `10000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`,
    subject: `20000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`,
    password: secret(),
  }));
  put("test-accounts.json", JSON.stringify({issuer,users},null,2));
  put("bootstrap.json", JSON.stringify({issuer,organization:{id:org,slug:"console-staging",name:"Console Staging"},
    users: users.filter(u=>u.role!=="outsider").map(({password,...u})=>u)},null,2));
  env("postgres.env", { POSTGRES_USER:"postgres",POSTGRES_PASSWORD:db.postgres,POSTGRES_DB:"postgres",
    POSTGRES_INITDB_ARGS:"--auth-host=scram-sha-256",CONSOLE_DB_PASSWORD:db.console,
    WORKFLOW_DB_PASSWORD:db.workflow,KEYCLOAK_DB_PASSWORD:db.keycloak });
  env("keycloak.env", { KC_DB_PASSWORD:db.keycloak, KC_BOOTSTRAP_ADMIN_USERNAME:"staging-admin",KC_BOOTSTRAP_ADMIN_PASSWORD:secret() });
  env("s3.env", {AWS_ACCESS_KEY_ID:accessKey,AWS_SECRET_ACCESS_KEY:s3secret,S3_BUCKET:"pages"});
  const storage = { RAVI_PAGES_R2_ENDPOINT:"https://s3.nba-console.test",RAVI_PAGES_R2_BUCKET:"pages",
    RAVI_PAGES_R2_ACCESS_KEY_ID:accessKey,RAVI_PAGES_R2_SECRET_ACCESS_KEY:s3secret,RAVI_PAGES_R2_REGION:"us-east-1" };
  env("console.env", { NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",PORT:"3000",HOSTNAME:"0.0.0.0",
    DATABASE_URL:`postgres://console:${db.console}@postgres:5432/console`,DATABASE_URL_UNPOOLED:`postgres://console:${db.console}@postgres:5432/console`,
    RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK:"true", RAVI_AUTH_MODE:"oidc",RAVI_OIDC_ISSUER:issuer,
    RAVI_OIDC_CLIENT_ID:"console",RAVI_OIDC_CLIENT_SECRET:clients.console,RAVI_AUTH_SECRET:secret(),
    NEXT_PUBLIC_CONSOLE_URL:"https://console.nba-console.test",RAVI_SINGLE_TENANT_ORGANIZATION_ID:org,
    RAVI_PAGES_HOSTED_DOMAIN:"pages.nba-console.test",RAVI_PAGES_CONTROL_TOKEN:pagesControl,
    RAVI_PAGES_AUTH_SESSION_SECRET:secret(),RAVI_CLI_ACCESS_TOKEN_SECRET:secret(),RAVI_BASES_CURSOR_SECRET:secret(),
    RAVI_PAGES_VIEWER_ASSERTION_ISSUER:"https://console.nba-console.test",
    RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON:JSON.stringify([{kid:"pages-viewer-assertion-staging-1",alg:"ES256",status:"active",pkcs8Pem:assertion.privateKey}]),
    RAVI_EXECUTOR_PRIVATE_KEY_PEM:delegation.privateKey,RAVI_EXECUTOR_PUBLIC_KEY_PEM:callback.publicKey,
    RAVI_EXECUTOR_URL:"https://executor.nba-console.test",RAVI_PAGES_CAPTURE_PROVIDER:"playwright",
    WORKFLOW_TARGET_WORLD:"@workflow/world-postgres",WORKFLOW_POSTGRES_URL:`postgres://workflow:${db.workflow}@postgres:5432/workflow`,
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY:"5",WORKFLOW_POSTGRES_MAX_POOL_SIZE:"10",WORKFLOW_POSTGRES_POLL_INTERVAL_MS:"1000",
    WORKFLOW_LOCAL_BASE_URL:"http://127.0.0.1:3000",RAVI_PAGES_AI_ENABLED:"0",
    NODE_EXTRA_CA_CERTS:"/run/tls/ca.crt",...storage });
  env("pages.env",{PORT:"8787",RAVI_PAGES_BIND:"0.0.0.0",RAVI_PAGES_TRUST_PROXY:"1",
    RAVI_PAGES_STATE_DIR:"/var/lib/ravi-pages",RAVI_CONSOLE_API_URL:"https://console.nba-console.test",
    RAVI_PAGES_HOSTED_DOMAIN:"pages.nba-console.test",RAVI_PAGES_CONTROL_TOKEN:pagesControl,
    NODE_EXTRA_CA_CERTS:"/run/tls/ca.crt",...storage});
  env("executor.env",{NODE_ENV:"production",EXECUTOR_HOST:"0.0.0.0",PORT:"4788",
    EXECUTOR_DATA_DIR:"/data",EXECUTOR_DB_PATH:"/data/executor.db",EXECUTOR_WEB_BASE_URL:"https://executor.nba-console.test",
    EXECUTOR_TRUSTED_ORIGINS:"https://executor.nba-console.test",BETTER_AUTH_SECRET:secret(),EXECUTOR_SECRET_KEY:secret(),
    EXECUTOR_ORG_NAME:"Console Staging",EXECUTOR_ORG_SLUG:"console-staging",EXECUTOR_DISABLE_ANALYTICS:"true",
    EXECUTOR_SSO_PROVIDER_ID:"customer-sso",EXECUTOR_SSO_PROVIDER_NAME:"SSO da instalação",EXECUTOR_SSO_DISCOVERY_URL:`${issuer}/.well-known/openid-configuration`,
    EXECUTOR_SSO_CLIENT_ID:"executor",EXECUTOR_SSO_CLIENT_SECRET:clients.executor,EXECUTOR_SSO_ALLOWED_DOMAINS:"staging.invalid",
    EXECUTOR_SSO_ONLY:"true",EXECUTOR_IDENTITY_AUTHORITY_ORIGIN:"https://console.nba-console.test",
    EXECUTOR_DELEGATION_ISSUER:"https://console.nba-console.test",
    EXECUTOR_IDENTITY_ISSUER:issuer,EXECUTOR_AUTHORITY_ORGANIZATION_ID:org,
    EXECUTOR_DELEGATION_PUBLIC_KEY_PEM:delegation.publicKey,EXECUTOR_CALLBACK_PRIVATE_KEY_PEM:callback.privateKey,
    NODE_EXTRA_CA_CERTS:"/run/tls/ca.crt" });
  const client = (id:string,callbackPath:string) => ({clientId:id,name:id,enabled:true,protocol:"openid-connect",publicClient:false,
    secret:clients[id as keyof typeof clients],standardFlowEnabled:true,directAccessGrantsEnabled:false,serviceAccountsEnabled:false,
    redirectUris:[`https://${id}.nba-console.test${callbackPath}`],webOrigins:[`https://${id}.nba-console.test`],
    attributes:{"pkce.code.challenge.method":"S256","post.logout.redirect.uris":`https://${id}.nba-console.test/*`},
    defaultClientScopes:["web-origins","acr","profile","email"]});
  put("realm.json",JSON.stringify({realm:"console-staging",enabled:true,sslRequired:"all",registrationAllowed:false,
    resetPasswordAllowed:false,rememberMe:false,verifyEmail:false,loginWithEmailAllowed:true,duplicateEmailsAllowed:false,
    bruteForceProtected:true,clients:[client("console","/callback"),client("executor","/api/auth/oauth2/callback/customer-sso")],
    users:users.map(u=>({id:u.subject,username:u.email,email:u.email,emailVerified:true,enabled:true,firstName:"Staging",lastName:u.role,
      credentials:[{type:"password",value:u.password,temporary:false}]}))},null,2));
  put("tls/openssl.cnf",`[req]\ndistinguished_name=dn\n[dn]\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:console.nba-console.test,DNS:idp.nba-console.test,DNS:s3.nba-console.test,DNS:executor.nba-console.test,DNS:*.pages.nba-console.test\n`);
  const tls = (name:string)=>join(root,"tls",name);
  command(["req","-x509","-newkey","rsa:3072","-nodes","-keyout",tls("ca.key"),"-out",tls("ca.crt"),"-days","7","-sha256","-subj","/CN=NBA Console Staging Task-local CA","-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign,cRLSign"]);
  command(["req","-new","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout",tls("server.key"),"-out",tls("server.csr"),"-subj","/CN=console.nba-console.test"]);
  command(["x509","-req","-in",tls("server.csr"),"-CA",tls("ca.crt"),"-CAkey",tls("ca.key"),"-CAcreateserial","-out",tls("server.crt"),"-days","7","-sha256","-extfile",tls("openssl.cnf"),"-extensions","leaf"]);
  for (const name of ["ca.key","server.key"]) chmodSync(tls(name),0o600);
  const pub = spawnSync("openssl",["x509","-in",tls("server.crt"),"-pubkey","-noout"],{encoding:"utf8"});
  const der = spawnSync("openssl",["pkey","-pubin","-outform","DER"],{input:pub.stdout});
  if(pub.status!==0||der.status!==0)throw new Error("tls_public_key_failed");
  put("tls/spki.txt",createHash("sha256").update(der.stdout).digest("base64")+"\n");
  console.log("Generated isolated staging secrets and 7-day CA. No values emitted; CA private key stays local.");
} catch (error) {
  // Deliberately never emit exception messages or underlying command/env payloads.
  console.error("Secret preparation failed; inspect control flow locally without dumping secret files.");
  process.exitCode=1;
}
