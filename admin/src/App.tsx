// Panel de administración de GalipauStats: clubes, equipos por temporada y sus
// dos códigos de invitación. Separado de la PWA de entrenadores y familias.
// Todas las escrituras son operaciones críticas: si no están habilitadas en el
// entorno, los formularios aparecen desactivados.
import { ChevronLeft, ChevronRight, Copy, Eye, EyeOff, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from './api';
import {
  CODE_LABEL,
  canManageClub,
  formatDay,
  GENDER_LABEL,
  groupBySeason,
  isSuperadmin,
  isValidSeason,
  isValidTeamCode,
  maskCode,
  normalizeTeamCode,
  STATUS_LABEL,
  type ClubDetail,
  type ClubSummary,
  type Gender,
  type Me,
  type TeamCodes,
  type TeamRole,
  type TeamSummary,
} from './format';

// --- Navegación por hash ------------------------------------------------------

type Route = { name: 'clubs' } | { name: 'club'; clubId: string } | { name: 'team'; clubId: string; teamId: string };

function parseRoute(hash: string): Route {
  const [a, clubId, b, teamId] = hash.replace(/^#\/?/, '').split('/');
  if (a === 'clubs' && clubId && b === 'teams' && teamId) return { name: 'team', clubId, teamId };
  if (a === 'clubs' && clubId) return { name: 'club', clubId };
  return { name: 'clubs' };
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const go = (hash: string) => (window.location.hash = hash);

// --- Carga de datos ----------------------------------------------------------

function useData<T>(path: string | null): { data: T | undefined; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error: string | null }>({ error: null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<T>(path).then(
      (data) => !cancelled && setState({ data, error: null }),
      (e: unknown) => !cancelled && setState({ error: e instanceof ApiError ? e.message : 'Error de conexión.' }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  return { data: state.data, error: state.error, reload: useCallback(() => setVersion((v) => v + 1), []) };
}

/** Ejecuta una escritura y devuelve su error como texto. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Error de conexión.');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

// --- Piezas comunes -------------------------------------------------------------

function TopBar({ title, subtitle, back }: { title: string; subtitle?: string; back?: string }) {
  return (
    <header className="topbar">
      {back && (
        <button type="button" className="icon-btn" onClick={() => go(back)} aria-label="Volver">
          <ChevronLeft size={24} aria-hidden="true" />
        </button>
      )}
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <span>{subtitle}</span>}
      </div>
    </header>
  );
}

function WritesDisabled() {
  return (
    <p className="notice">
      <ShieldCheck size={18} aria-hidden="true" />
      Las operaciones de escritura (crear, editar, suspender y gestionar códigos) están desactivadas en este entorno hasta
      completar la verificación de seguridad.
    </p>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label>
      {label}
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

// --- Clubes ----------------------------------------------------------------------

function ClubsScreen({ me }: { me: Me }) {
  const { data, error, reload } = useData<{ clubs: ClubSummary[] }>('/api/admin/clubs');
  const action = useAction();
  const [name, setName] = useState('');
  const writable = me.criticalOpsEnabled;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const res = await action.run(() => api<{ clubId: string }>('/api/admin/critical/clubs', { method: 'POST', body: { name } }));
    if (res) {
      setName('');
      reload();
    }
  };

  return (
    <div className="screen">
      <TopBar title="Administración" subtitle={me.email} />
      <main className="content">
        {!writable && <WritesDisabled />}
        <h2 className="section-title">Clubes</h2>
        {error && <p className="form-error">{error}</p>}
        {data?.clubs.length === 0 && (
          <div className="empty-card">
            <strong>Todavía no hay clubes</strong>
            <span>{isSuperadmin(me) ? 'Crea el primero con el formulario de abajo.' : 'No administras ningún club activo.'}</span>
          </div>
        )}
        <ul className="list">
          {data?.clubs.map((c) => (
            <li key={c.id}>
              <button type="button" className="list-item" onClick={() => go(`#/clubs/${c.id}`)}>
                <span className="list-main">
                  <strong>{c.name}</strong>
                  {c.shortName && <span className="muted">{c.shortName}</span>}
                </span>
                <span className={`status ${c.status === 'suspended' ? 'status-suspended' : ''}`}>{STATUS_LABEL[c.status]}</span>
                <ChevronRight className="chevron" size={20} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {isSuperadmin(me) && (
          <form className="card form" onSubmit={create}>
            <h3>Nuevo club</h3>
            <Field label="Nombre del club">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Club Balonmano Burjassot" disabled={!writable} />
            </Field>
            {action.error && <p className="form-error">{action.error}</p>}
            <button type="submit" className="btn btn-primary" disabled={!writable || action.busy || !name.trim()}>
              <Plus size={20} aria-hidden="true" />
              Crear club
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

// --- Club -------------------------------------------------------------------------

const EMPTY_TEAM = { name: '', code: '', season: '', category: '', gender: '' as Gender | '' };

function ClubScreen({ me, clubId }: { me: Me; clubId: string }) {
  const { data: club, error, reload } = useData<ClubDetail>(`/api/admin/clubs/${encodeURIComponent(clubId)}`);
  const writable = me.criticalOpsEnabled && canManageClub(me, clubId);
  const edit = useAction();
  const status = useAction();
  const create = useAction();
  const [form, setForm] = useState<{ name: string; shortName: string } | null>(null);
  const [team, setTeam] = useState(EMPTY_TEAM);

  if (error) return <Screen title="Club" back="#/"><p className="form-error">{error}</p></Screen>;
  if (!club) return <Screen title="Club" back="#/" />;
  const values = form ?? { name: club.name, shortName: club.shortName ?? '' };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await edit.run(() => api(`/api/admin/critical/clubs/${club.id}`, { method: 'PATCH', body: values }))) {
      setForm(null);
      reload();
    }
  };
  const setStatus = async (next: 'active' | 'suspended') => {
    if (await status.run(() => api(`/api/admin/critical/clubs/${club.id}/status`, { method: 'POST', body: { status: next } }))) reload();
  };
  const teamValid = team.name.trim() && isValidTeamCode(team.code) && isValidSeason(team.season);
  const addTeam = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...team, code: normalizeTeamCode(team.code), gender: team.gender || null };
    if (await create.run(() => api(`/api/admin/critical/clubs/${club.id}/teams`, { method: 'POST', body }))) {
      setTeam(EMPTY_TEAM);
      reload();
    }
  };

  return (
    <Screen title={club.name} subtitle={STATUS_LABEL[club.status]} back="#/">
      {!me.criticalOpsEnabled && <WritesDisabled />}
      {club.status === 'suspended' && (
        <p className="notice">Club suspendido: sus entrenadores y familias no pueden acceder a los equipos hasta reactivarlo.</p>
      )}

      <h2 className="section-title">Equipos</h2>
      {club.teams.length === 0 && (
        <div className="empty-card">
          <strong>Sin equipos</strong>
          <span>Crea los equipos de cada temporada con el formulario de abajo.</span>
        </div>
      )}
      {groupBySeason(club.teams).map(([season, teams]) => (
        <section key={season}>
          <h3 className="section-title">Temporada {season}</h3>
          <ul className="list">
            {teams.map((t) => (
              <li key={t.id}>
                <button type="button" className="list-item" onClick={() => go(`#/clubs/${club.id}/teams/${t.id}`)}>
                  <span className="list-main">
                    <strong>{t.name}</strong>
                    <span className="muted">
                      {t.code}
                      {t.category ? ` · ${t.category}` : ''}
                      {t.gender ? ` · ${GENDER_LABEL[t.gender]}` : ''}
                    </span>
                  </span>
                  <span className="list-side">
                    <span className={`status ${t.codes.coach && t.codes.viewer ? '' : 'status-suspended'}`}>
                      {t.codes.coach && t.codes.viewer ? '2 códigos' : 'Faltan códigos'}
                    </span>
                  </span>
                  <ChevronRight className="chevron" size={20} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {canManageClub(me, clubId) && (
        <form className="card form" onSubmit={addTeam}>
          <h3>Nuevo equipo</h3>
          <Field label="Nombre">
            <input value={team.name} onChange={(e) => setTeam({ ...team, name: e.target.value })} placeholder="Senior Masculino A" disabled={!writable} />
          </Field>
          <div className="form-row">
            <Field label="Identificador" hint="3–12 letras o números. No da acceso.">
              <input value={team.code} onChange={(e) => setTeam({ ...team, code: e.target.value })} placeholder="SMA2627" disabled={!writable} />
            </Field>
            <Field label="Temporada">
              <input value={team.season} onChange={(e) => setTeam({ ...team, season: e.target.value })} placeholder="2026/27" disabled={!writable} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Categoría">
              <input value={team.category} onChange={(e) => setTeam({ ...team, category: e.target.value })} placeholder="Senior" disabled={!writable} />
            </Field>
            <Field label="Modalidad">
              <select value={team.gender} onChange={(e) => setTeam({ ...team, gender: e.target.value as Gender | '' })} disabled={!writable}>
                <option value="">—</option>
                {(Object.keys(GENDER_LABEL) as Gender[]).map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABEL[g]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="hint">Al crearlo se generan sus dos códigos (entrenador y jugador/familia), válidos toda la temporada.</p>
          {create.error && <p className="form-error">{create.error}</p>}
          <button type="submit" className="btn btn-primary" disabled={!writable || create.busy || !teamValid}>
            <Plus size={20} aria-hidden="true" />
            Crear equipo
          </button>
        </form>
      )}

      {canManageClub(me, clubId) && (
        <form className="card form" onSubmit={save}>
          <h3>Datos del club</h3>
          <Field label="Nombre">
            <input value={values.name} onChange={(e) => setForm({ ...values, name: e.target.value })} maxLength={120} disabled={!writable} />
          </Field>
          <Field label="Nombre corto">
            <input value={values.shortName} onChange={(e) => setForm({ ...values, shortName: e.target.value })} maxLength={60} disabled={!writable} />
          </Field>
          {edit.error && <p className="form-error">{edit.error}</p>}
          <button type="submit" className="btn" disabled={!writable || edit.busy || !form || !values.name.trim()}>
            Guardar cambios
          </button>
        </form>
      )}

      {isSuperadmin(me) && (
        <section className="card form">
          <h3>Estado del club</h3>
          <p className="hint">
            Suspender impide a entrenadores, familias y al administrador del club acceder a sus equipos. Es reversible y no borra
            nada.
          </p>
          {status.error && <p className="form-error">{status.error}</p>}
          {club.status === 'active' ? (
            <button type="button" className="btn btn-danger-outline" disabled={!me.criticalOpsEnabled || status.busy} onClick={() => setStatus('suspended')}>
              Suspender club
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!me.criticalOpsEnabled || status.busy} onClick={() => setStatus('active')}>
              Reactivar club
            </button>
          )}
        </section>
      )}
    </Screen>
  );
}

// --- Equipo y sus códigos ------------------------------------------------------------

function CodeCard({ role, view, teamId, writable, onChanged }: { role: TeamRole; view: TeamCodes['viewer']; teamId: string; writable: boolean; onChanged: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const label = CODE_LABEL[role];

  const copy = async () => {
    if (!view?.code) return;
    await navigator.clipboard.writeText(view.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const regenerate = async () => {
    if (!window.confirm(`¿Regenerar el ${label.title.toLowerCase()}? El actual dejará de valer para nuevos dispositivos; los que ya entraron conservan el acceso.`)) return;
    if (await action.run(() => api(`/api/admin/critical/teams/${teamId}/codes/${role}/regenerate`, { method: 'POST', body: {} }))) onChanged();
  };
  const revoke = async () => {
    if (!window.confirm(`¿Revocar el ${label.title.toLowerCase()} sin crear otro? El otro código no cambia.`)) return;
    if (await action.run(() => api(`/api/admin/critical/teams/${teamId}/codes/${role}/revoke`, { method: 'POST', body: {} }))) onChanged();
  };

  return (
    <section className="card code-card">
      <h3>
        <KeyRound size={16} aria-hidden="true" /> {label.title}
      </h3>
      <p className="hint">{label.detail}</p>
      {view ? (
        <>
          <div className="code-value" aria-live="polite">
            {view.code ? (shown ? view.code : maskCode(view.code)) : 'No disponible: regenéralo para poder mostrarlo'}
          </div>
          <p className="hint">Válido hasta el {formatDay(view.expiresAt)}</p>
          {view.code && (
            <div className="code-actions">
              <button type="button" className="btn btn-sm" onClick={() => setShown(!shown)}>
                {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                {shown ? 'Ocultar' : 'Mostrar'}
              </button>
              <button type="button" className="btn btn-sm" onClick={copy}>
                <Copy size={16} aria-hidden="true" />
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="empty">Sin código vigente.</p>
      )}
      {action.error && <p className="form-error">{action.error}</p>}
      <div className="code-actions">
        <button type="button" className="btn btn-sm" disabled={!writable || action.busy} onClick={regenerate}>
          <RefreshCw size={16} aria-hidden="true" />
          {view ? 'Regenerar' : 'Generar'}
        </button>
        {view && (
          <button type="button" className="btn btn-sm btn-danger-outline" disabled={!writable || action.busy} onClick={revoke}>
            <Trash2 size={16} aria-hidden="true" />
            Revocar
          </button>
        )}
      </div>
    </section>
  );
}

function TeamScreen({ me, clubId, teamId }: { me: Me; clubId: string; teamId: string }) {
  const { data: club } = useData<ClubDetail>(`/api/admin/clubs/${encodeURIComponent(clubId)}`);
  const codes = useData<TeamCodes>(`/api/admin/teams/${encodeURIComponent(teamId)}/codes`);
  const team: TeamSummary | undefined = club?.teams.find((t) => t.id === teamId);
  const writable = me.criticalOpsEnabled && canManageClub(me, clubId);
  const edit = useAction();
  const [form, setForm] = useState<{ name: string; category: string; gender: Gender | '' } | null>(null);
  const back = `#/clubs/${clubId}`;

  if (!team) return <Screen title="Equipo" back={back}>{codes.error && <p className="form-error">{codes.error}</p>}</Screen>;
  const values = form ?? { name: team.name, category: team.category ?? '', gender: team.gender ?? '' };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await edit.run(() => api(`/api/admin/critical/teams/${team.id}`, { method: 'PATCH', body: { ...values, gender: values.gender || null } }))) {
      setForm(null);
      window.location.reload();
    }
  };

  return (
    <Screen title={team.name} subtitle={`${team.code} · Temporada ${team.season}`} back={back}>
      {!me.criticalOpsEnabled && <WritesDisabled />}
      <p className="hint">
        El identificador <strong>{team.code}</strong> solo identifica al equipo: no da acceso. Para entrar se usan los dos códigos
        siguientes, independientes entre sí.
      </p>
      {codes.error && <p className="form-error">{codes.error}</p>}
      {codes.data && (
        <>
          <CodeCard role="coach" view={codes.data.coach ?? null} teamId={team.id} writable={writable} onChanged={codes.reload} />
          <CodeCard role="viewer" view={codes.data.viewer} teamId={team.id} writable={writable} onChanged={codes.reload} />
        </>
      )}
      {canManageClub(me, clubId) && (
        <form className="card form" onSubmit={save}>
          <h3>Datos del equipo</h3>
          <Field label="Nombre">
            <input value={values.name} onChange={(e) => setForm({ ...values, name: e.target.value })} disabled={!writable} />
          </Field>
          <div className="form-row">
            <Field label="Categoría">
              <input value={values.category} onChange={(e) => setForm({ ...values, category: e.target.value })} disabled={!writable} />
            </Field>
            <Field label="Modalidad">
              <select value={values.gender} onChange={(e) => setForm({ ...values, gender: e.target.value as Gender | '' })} disabled={!writable}>
                <option value="">—</option>
                {(Object.keys(GENDER_LABEL) as Gender[]).map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABEL[g]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="hint">El identificador y la temporada no se cambian: la temporada siguiente tiene equipos nuevos.</p>
          {edit.error && <p className="form-error">{edit.error}</p>}
          <button type="submit" className="btn" disabled={!writable || edit.busy || !form || !values.name.trim()}>
            Guardar cambios
          </button>
        </form>
      )}
    </Screen>
  );
}

function Screen({ title, subtitle, back, children }: { title: string; subtitle?: string; back?: string; children?: ReactNode }) {
  return (
    <div className="screen">
      <TopBar title={title} subtitle={subtitle} back={back} />
      <main className="content">{children}</main>
    </div>
  );
}

export function App() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const me = useData<Me>('/api/admin/me');
  if (me.error) return <Screen title="Administración"><p className="form-error">{me.error}</p></Screen>;
  if (!me.data) return <Screen title="Administración" />;
  const route = parseRoute(hash);
  switch (route.name) {
    case 'clubs':
      return <ClubsScreen me={me.data} />;
    case 'club':
      return <ClubScreen key={route.clubId} me={me.data} clubId={route.clubId} />;
    case 'team':
      return <TeamScreen key={route.teamId} me={me.data} clubId={route.clubId} teamId={route.teamId} />;
  }
}
