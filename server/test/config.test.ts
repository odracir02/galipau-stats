// La configuración de entornos no debe permitir tocar producción por accidente.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accessConfig } from '../src/access';

interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir: string;
}
interface EnvConfig {
  name: string;
  vars: Record<string, string>;
  d1_databases: D1Binding[];
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
// wrangler.jsonc solo usa comentarios de línea completa.
const config = JSON.parse(
  read('../wrangler.jsonc')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n'),
) as EnvConfig & { env: Record<'preview' | 'production', EnvConfig> };

const envs: Record<string, EnvConfig> = { local: config, preview: config.env.preview, production: config.env.production };

describe('entornos del Worker', () => {
  it('cada entorno tiene su propio Worker y su propia base de datos', () => {
    const names = Object.values(envs).map((e) => e.name);
    const dbNames = Object.values(envs).map((e) => e.d1_databases[0]!.database_name);
    const dbIds = Object.values(envs).map((e) => e.d1_databases[0]!.database_id);
    expect(new Set(names).size).toBe(3);
    expect(new Set(dbNames).size).toBe(3);
    expect(new Set(dbIds).size).toBe(3);
    expect(envs.local!.name).not.toBe(envs.production!.name);
  });

  it('solo el entorno de producción nombra la base de datos de producción', () => {
    for (const [env, cfg] of Object.entries(envs)) {
      const db = cfg.d1_databases[0]!;
      expect(db.binding).toBe('DB');
      expect(db.migrations_dir).toBe('migrations');
      expect(db.database_name.endsWith('-production')).toBe(env === 'production');
    }
  });

  it('cada entorno solo acepta peticiones de su propia aplicación', () => {
    expect(envs.preview!.vars.ALLOWED_ORIGINS).toBe('https://develop.galipau-stats.pages.dev');
    expect(envs.production!.vars.ALLOWED_ORIGINS).toBe('https://galipau-stats.pages.dev');
    expect(envs.local!.vars.ALLOWED_ORIGINS).not.toMatch(/pages\.dev/);
    for (const [env, cfg] of Object.entries(envs)) expect(cfg.vars.ENVIRONMENT).toBe(env);
  });

  it('no hay secretos en la configuración ni comandos remotos en los scripts', () => {
    for (const cfg of Object.values(envs)) expect(Object.keys(cfg.vars)).not.toContain('TOKEN_PEPPER');
    const scripts = JSON.parse(read('../package.json')).scripts as Record<string, string>;
    for (const cmd of Object.values(scripts)) {
      expect(cmd).not.toMatch(/--remote|wrangler deploy(?!.*--dry-run)|secret put/);
    }
    expect(read('../.dev.vars.example')).toMatch(/TOKEN_PEPPER=solo-para-desarrollo-local/);
  });

  it('Cloudflare Access: misma configuración en todos los entornos, sin atajos de desarrollo', () => {
    for (const [env, cfg] of Object.entries(envs)) {
      for (const key of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD_ADMIN', 'ACCESS_AUD_CRITICAL']) expect(Object.keys(cfg.vars), env).toContain(key);
      // Ninguna variable que desactive o simule la autenticación.
      for (const key of Object.keys(cfg.vars)) expect(key, env).not.toMatch(/BYPASS|SKIP|INSECURE|FAKE|MOCK|DEV_AUTH|NO_AUTH/i);
    }
    // En local no hay Access: la administración queda desactivada, no abierta.
    expect(accessConfig(envs.local!.vars)).toBeNull();
    // Si se rellenan, preview y producción no pueden compartir aplicaciones de Access.
    const p = envs.preview!.vars;
    const q = envs.production!.vars;
    if (p.ACCESS_AUD_ADMIN && q.ACCESS_AUD_ADMIN) {
      expect(p.ACCESS_AUD_ADMIN).not.toBe(q.ACCESS_AUD_ADMIN);
      expect(p.ACCESS_AUD_CRITICAL).not.toBe(q.ACCESS_AUD_CRITICAL);
    }
    for (const v of [p, q]) if (v.ACCESS_TEAM_DOMAIN) expect(accessConfig(v)).not.toBeNull();
  });
});

describe('superficie de acceso al Worker', () => {
  it('las operaciones críticas están desactivadas en todos los entornos del repositorio', () => {
    // Solo se habilitan tras verificar a mano el segundo factor en Cloudflare.
    for (const [env, cfg] of Object.entries(envs)) expect(cfg.vars.ADMIN_CRITICAL_OPS, env).toBe('disabled');
  });

  it('sin URLs de vista previa por versión en ningún entorno', () => {
    const raw = config as unknown as { preview_urls?: boolean; env: Record<string, { preview_urls?: boolean }> };
    expect(raw.preview_urls).toBe(false);
    for (const e of Object.values(raw.env)) expect(e.preview_urls ?? false).toBe(false);
  });
});
