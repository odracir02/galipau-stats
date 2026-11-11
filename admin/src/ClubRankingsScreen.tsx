// «Rankings del club»: funcionan solos. Cada temporada reúne a todos los equipos
// del club (sin activar equipos, grupos ni visibilidad) y los ven los
// entrenadores y la consulta (familias) de cualquier equipo del club. Aquí solo
// se explica qué se muestra y se revisa la clasificación completa, ya calculada
// por el servidor; las uniones de fichas y las exclusiones están en «Jugadores
// del club».
import { ShieldAlert, Trophy } from 'lucide-react';
import { useState } from 'react';
import { canManageClub, type ClubDetail, type Me } from './format';
import { rankingSeasons, rankingTitle, rankingValue, seasonQuery, type ClubPeople, type ClubRankingsView } from './people';
import { useData } from './hooks';
import { Field, Screen } from './ui';

export function ClubRankingsScreen({ me, clubId }: { me: Me; clubId: string }) {
  const club = useData<ClubDetail>(`/api/admin/clubs/${encodeURIComponent(clubId)}`);
  const data = useData<ClubPeople>(`/api/admin/clubs/${encodeURIComponent(clubId)}/people`);
  const back = `#/clubs/${clubId}`;
  const title = 'Rankings del club';

  if (!canManageClub(me, clubId)) return <Screen title={title} back={back}><p className="form-error">No administras este club.</p></Screen>;
  if (data.error) return <Screen title={title} back={back}><p className="form-error">{data.error}</p></Screen>;
  if (!data.data) return <Screen title={title} subtitle="Cargando…" back={back} />;

  return (
    <Screen title={title} subtitle={club.data?.name} back={back}>
      <p className="hint">
        Cada temporada, «Todo el club» reúne automáticamente a todos los equipos del club, sean del género o la categoría que
        sean. No hay que activar nada.
      </p>
      <p className="notice">
        <ShieldAlert size={18} aria-hidden="true" />
        <span>
          Los entrenadores y quienes tengan un código de consulta de cualquier equipo del club ven el Top 10 de cada clasificación,
          con el nombre visible y las cifras de jugadores de todos los equipos. Si alguien no debe aparecer (por ejemplo, porque lo
          pide o porque es menor y falta la autorización), exclúyelo en «Jugadores del club»; allí también puedes unir las fichas de
          quien juega en varios equipos y darle un nombre visible adecuado.
        </span>
      </p>
      <Verification clubId={clubId} seasons={rankingSeasons(data.data.rankings.teams)} />
    </Screen>
  );
}

/** Clasificación completa ya calculada por el servidor, para revisarla. Solo lectura. */
function Verification({ clubId, seasons }: { clubId: string; seasons: readonly string[] }) {
  const [chosen, setChosen] = useState(0);
  const season = seasons[chosen] ?? seasons[0];
  const view = useData<ClubRankingsView>(season ? `/api/admin/clubs/${encodeURIComponent(clubId)}/rankings?${seasonQuery(season)}` : null);

  return (
    <section className="card form">
      <h3>
        <Trophy size={16} aria-hidden="true" /> Revisar las clasificaciones
      </h3>
      {seasons.length === 0 ? (
        <p className="empty">El club no tiene equipos todavía: no hay clasificaciones que revisar.</p>
      ) : (
        <>
          {seasons.length > 1 && (
            <Field label="Temporada">
              <select value={chosen} onChange={(e) => setChosen(Number(e.target.value))}>
                {seasons.map((s, i) => (
                  <option key={s} value={i}>
                    Todo el club · {s}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {view.error && <p className="form-error">{view.error}</p>}
          {!view.data && !view.error && <p className="hint">Cargando…</p>}
          {view.data && (
            <>
              <p className="hint">
                Todo el club · {view.data.season}. Equipos: {view.data.teams.map((t) => t.code).join(', ') || '—'}. Clasificación
                completa (entrenadores y familias ven el Top 10).
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
