// «Rankings del club»: qué equipos participan, en qué grupo de clasificación y
// quién ve los rankings. Solo ofrece lo que el servidor permite: reducir la
// visibilidad es administración normal; ampliarla a entrenadores es una
// operación crítica (verificación reforzada); jugadores y familias, todavía no.
// Las clasificaciones se consultan ya calculadas por el servidor: aquí no se
// calcula nada.
import { Lock, ShieldAlert, Trophy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ConfirmSheet } from '../../src/ui/components/Sheet';
import { api } from './api';
import { canManageClub, GENDER_LABEL, type ClubDetail, type Me } from './format';
import {
  groupQuery,
  rankingGroups,
  rankingTitle,
  rankingValue,
  teamRankingProblem,
  VISIBILITY_LABEL,
  type ClubPeople,
  type ClubRankingsView,
  type GroupKey,
  type RankingsTeam,
} from './people';
import { useAction, useData } from './hooks';
import { ActionError, Field, Screen } from './ui';

/** `review`: exige marcar que se ha revisado la privacidad antes de confirmar. */
type Confirm = { title: string; message: ReactNode; label: string; danger?: boolean; review?: boolean; run: () => Promise<unknown> };

const groupLabel = (g: GroupKey) => `${g.group} · ${GENDER_LABEL[g.gender]} · ${g.season}`;

export function ClubRankingsScreen({ me, clubId }: { me: Me; clubId: string }) {
  const club = useData<ClubDetail>(`/api/admin/clubs/${encodeURIComponent(clubId)}`);
  const data = useData<ClubPeople>(`/api/admin/clubs/${encodeURIComponent(clubId)}/people`);
  const action = useAction();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [groups, setGroups] = useState<Record<string, string>>({});
  const back = `#/clubs/${clubId}`;
  const title = 'Rankings del club';

  if (!canManageClub(me, clubId)) return <Screen title={title} back={back}><p className="form-error">No administras este club.</p></Screen>;
  if (data.error) return <Screen title={title} back={back}><p className="form-error">{data.error}</p></Screen>;
  if (!data.data) return <Screen title={title} subtitle="Cargando…" back={back} />;
  const { visibility, teams } = data.data.rankings;

  const done = () => {
    setConfirm(null);
    setGroups({});
    data.reload();
  };
  const ask = (c: Confirm) => {
    action.clear();
    setReviewed(false);
    setConfirm(c);
  };
  const runConfirm = async () => {
    if (!confirm) return;
    const ok = await action.run(confirm.run);
    setConfirm(null);
    if (ok !== undefined) done();
  };
  const setTeam = (t: RankingsTeam, body: { participates?: boolean; group?: string | null }) =>
    api(`/api/admin/teams/${encodeURIComponent(t.teamId)}/rankings`, { method: 'PATCH', body });

  const bySeason = new Map<string, RankingsTeam[]>();
  for (const t of teams) bySeason.set(t.season, [...(bySeason.get(t.season) ?? []), t]);
  const privacyNotice = (
    <p className="notice">
      <ShieldAlert size={18} aria-hidden="true" />
      Los nombres visibles y las cifras de sus jugadores aparecerán en las clasificaciones del club que vean los administradores y,
      si se amplía, los entrenadores de los equipos participantes. Si el equipo tiene menores, actívalo solo con la información y el
      consentimiento necesarios.
    </p>
  );

  return (
    <Screen title={title} subtitle={club.data?.name} back={back}>
      <p className="hint">
        Las clasificaciones del club reúnen a los jugadores de los equipos que participan en un mismo grupo (misma temporada y
        modalidad). Están desactivadas hasta que actives equipos y les asignes un grupo.
      </p>
      <ActionError action={action} onReload={done} />

      <section className="card form">
        <h3>Quién ve los rankings del club</h3>
        <p>
          Ahora: <strong>{VISIBILITY_LABEL[visibility]}</strong>
        </p>
        <ul className="visibility-list">
          <li>
            <span className="list-main">
              <strong>{VISIBILITY_LABEL.admins}</strong>
              <span className="muted">Para revisar antes de abrirlos.</span>
            </span>
            {visibility !== 'admins' && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  ask({
                    title: 'Reducir quién los ve',
                    label: 'Reducir',
                    message: <p>Solo los administradores del club verán los rankings del club. Los entrenadores dejarán de verlos.</p>,
                    run: () => api(`/api/admin/clubs/${encodeURIComponent(clubId)}/rankings`, { method: 'PUT', body: { visibility: 'admins' } }),
                  })
                }
              >
                Reducir a esta
              </button>
            )}
          </li>
          <li>
            <span className="list-main">
              <strong>{VISIBILITY_LABEL.coaches}</strong>
              <span className="muted">
                <Lock size={14} aria-hidden="true" /> Operación crítica: te pedirá verificar de nuevo tu identidad.
                {!me.criticalOpsEnabled && ' Las operaciones críticas no están habilitadas en este entorno.'}
              </span>
            </span>
            {visibility === 'admins' && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={!me.criticalOpsEnabled}
                onClick={() =>
                  ask({
                    title: 'Abrir los rankings a los entrenadores',
                    label: 'Ampliar (verificación reforzada)',
                    message: (
                      <>
                        <p>Los entrenadores de los equipos participantes verán el Top 10 de cada clasificación de su grupo, con nombres y cifras de jugadores de otros equipos del club.</p>
                        <p>Es una operación crítica: se te pedirá verificar de nuevo tu identidad.</p>
                      </>
                    ),
                    run: () => api(`/api/admin/critical/clubs/${encodeURIComponent(clubId)}/rankings`, { method: 'PUT', body: { visibility: 'coaches' } }),
                  })
                }
              >
                Ampliar a esta
              </button>
            )}
          </li>
          <li className="unavailable">
            <span className="list-main">
              <strong>{VISIBILITY_LABEL.members}</strong>
              <span className="muted">No disponible todavía: faltan las condiciones de privacidad y consentimiento.</span>
            </span>
            <span className="status">No disponible</span>
          </li>
        </ul>
      </section>

      <h2 className="section-title">Equipos</h2>
      {teams.length === 0 && (
        <div className="empty-card">
          <strong>El club no tiene equipos</strong>
        </div>
      )}
      {[...bySeason.entries()].map(([season, list]) => (
        <section key={season}>
          <h3 className="section-title">Temporada {season}</h3>
          <ul className="list">
            {list.map((t) => {
              const problem = teamRankingProblem(t);
              const draft = groups[t.teamId] ?? t.group ?? '';
              const changed = draft.trim() !== (t.group ?? '');
              return (
                <li key={t.teamId} className="card team-ranking">
                  <div className="team-ranking-head">
                    <span className="list-main">
                      <strong>{t.name}</strong>
                      <span className="muted">
                        {t.code}
                        {t.gender ? ` · ${GENDER_LABEL[t.gender]}` : ' · sin modalidad'}
                      </span>
                    </span>
                    <span className={`status ${t.participates ? 'status-on' : ''}`}>{t.participates ? 'Participa' : 'No participa'}</span>
                  </div>
                  {problem && <p className="hint">{problem}</p>}
                  <div className="form inline-form">
                    <Field label="Grupo de clasificación" hint="Mismo nombre en los equipos que clasifican juntos (p. ej. senior).">
                      <input
                        value={draft}
                        maxLength={30}
                        placeholder="senior"
                        onChange={(e) => setGroups({ ...groups, [t.teamId]: e.target.value })}
                        list={`grupos-${clubId}`}
                      />
                    </Field>
                    <div className="code-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!changed || action.busy}
                        onClick={() =>
                          ask({
                            title: 'Cambiar el grupo',
                            label: 'Guardar grupo',
                            message: draft.trim() ? (
                              <p>
                                <strong>{t.name}</strong> clasificará en el grupo «{draft.trim()}».
                              </p>
                            ) : (
                              <p>
                                <strong>{t.name}</strong> se quedará sin grupo y no aparecerá en ninguna clasificación del club.
                              </p>
                            ),
                            run: () => setTeam(t, { group: draft.trim() || null }),
                          })
                        }
                      >
                        Guardar grupo
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${t.participates ? 'btn-danger-outline' : ''}`}
                        disabled={action.busy || (!t.participates && !t.gender)}
                        onClick={() =>
                          ask(
                            t.participates
                              ? {
                                  title: 'Dejar de participar',
                                  label: 'Dejar de participar',
                                  message: <p><strong>{t.name}</strong> dejará de aparecer en los rankings del club. Sus estadísticas no cambian.</p>,
                                  run: () => setTeam(t, { participates: false }),
                                }
                              : {
                                  title: 'Activar la participación',
                                  label: 'Activar',
                                  review: true,
                                  message: (
                                    <>
                                      <p>
                                        <strong>{t.name}</strong> ({t.code}) participará en los rankings del club.
                                      </p>
                                      {privacyNotice}
                                    </>
                                  ),
                                  run: () => setTeam(t, { participates: true }),
                                },
                          )
                        }
                      >
                        {t.participates ? 'Dejar de participar' : 'Activar participación'}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <datalist id={`grupos-${clubId}`}>
        {[...new Set(teams.map((t) => t.group).filter((g): g is string => !!g))].map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>

      <Verification clubId={clubId} teams={teams} />

      {confirm && (
        <ConfirmSheet
          title={confirm.title}
          message={
            <>
              {confirm.message}
              {confirm.review && (
                <label className="check confirm-check">
                  <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                  He revisado la privacidad de este equipo
                </label>
              )}
            </>
          }
          confirmLabel={action.busy ? 'Guardando…' : confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.review && !reviewed) return;
            void runConfirm();
          }}
        />
      )}
    </Screen>
  );
}

/** Clasificaciones ya calculadas por el servidor, para revisarlas. Solo lectura. */
function Verification({ clubId, teams }: { clubId: string; teams: readonly RankingsTeam[] }) {
  const groups = rankingGroups(teams);
  const [chosen, setChosen] = useState(0);
  const g = groups[chosen] ?? groups[0];
  const view = useData<ClubRankingsView>(g ? `/api/admin/clubs/${encodeURIComponent(clubId)}/rankings?${groupQuery(g)}` : null);

  return (
    <section className="card form">
      <h3>
        <Trophy size={16} aria-hidden="true" /> Revisar las clasificaciones
      </h3>
      {groups.length === 0 ? (
        <p className="empty">Ningún equipo participa todavía con un grupo y una modalidad: no hay clasificaciones que revisar.</p>
      ) : (
        <>
          <Field label="Grupo a revisar">
            <select value={chosen} onChange={(e) => setChosen(Number(e.target.value))}>
              {groups.map((x, i) => (
                <option key={groupLabel(x)} value={i}>
                  {groupLabel(x)}
                </option>
              ))}
            </select>
          </Field>
          {view.error && <p className="form-error">{view.error}</p>}
          {!view.data && !view.error && <p className="hint">Cargando…</p>}
          {view.data && (
            <>
              <p className="hint">
                Equipos: {view.data.teams.map((t) => t.code).join(', ') || '—'}. Clasificación completa (los entrenadores, si se les
                abre, solo ven el Top 10).
              </p>
              {view.data.rankings.map((r) => (
                <div key={r.id} className="club-ranking">
                  <h4>
                    {rankingTitle(r.id)} <span className="muted">({r.ranked})</span>
                  </h4>
                  {r.entries.length === 0 ? (
                    <p className="empty">Sin participantes todavía (sin partidos o sin el mínimo).</p>
                  ) : (
                    <ol className="rank-rows">
                      {r.entries.map((e, i) => (
                        <li key={`${e.position}-${i}`}>
                          <span className="rank-pos">{e.position}</span>
                          <span className="list-main">
                            <strong>{e.name}</strong>
                            <span className="muted">
                              {e.teams.join(' · ')} · {e.matches} PJ
                            </span>
                          </span>
                          <span className="rank-value">{rankingValue(r.id, e)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}
