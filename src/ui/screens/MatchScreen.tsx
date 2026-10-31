import { ChartColumn, List, Lock, SquarePen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../app/errors';
import { clubSync, teamPuller } from '../../app/remote';
import { useRemoteRevision, useTeamLink } from '../../app/useTeamSync';
import { repo } from '../../app/repo';
import { navigate } from '../../app/router';
import { showToast } from '../../app/toast';
import { useReadOnlyTeam } from '../../app/useImportedTeam';
import { useLoad } from '../../app/useLoad';
import { useWakeLock } from '../../app/useWakeLock';
import { describePayload } from '../../domain/catalog';
import { buildEvent, lastRecorded, type EventTiming } from '../../domain/events';
import { formatClock, formatDate, opponentLabel, publicTeamName } from '../../domain/format';
import type { EventPayload, Id, Match, MatchEvent, ScoreAdjustment, Team } from '../../domain/types';
import * as svc from '../../services/matchService';
import { actionAfterDisqualification, disqualifications, redCards } from '../../stats/discipline';
import { computeMatchStats } from '../../stats/engine';
import { ConfirmSheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { ClockHeader } from '../match/ClockHeader';
import { EventEditorSheet } from '../match/EventEditorSheet';
import { playerLabel } from '../match/labels';
import { LastActionBar } from '../match/LastActionBar';
import { ClockAdjustSheet, MatchMenuSheet, ScoreSheet } from '../match/MatchSheets';
import { RecordPanel } from '../match/RecordPanel';
import { ReductionSheet } from '../match/ReductionSheet';
import { Timeline } from '../match/Timeline';
import { StatsView } from '../stats/StatsView';
import { TopBar } from '../components/TopBar';

export function MatchScreen({ matchId }: { matchId: Id }) {
  // Cambia cuando llegan cambios del club a ESTE partido: se vuelve a leer.
  const revision = useRemoteRevision(undefined, matchId);
  const data = useLoad(async () => {
    const match = await repo.getMatch(matchId);
    if (!match || match.deletedAt) return null;
    const [team, events] = await Promise.all([repo.getTeam(match.teamId), repo.listEvents(match.id)]);
    return { match, team, events };
  }, [matchId, revision]);
  const loadedTeamId = data.data?.match.teamId;
  // Equipo bloqueado en este dispositivo (sin permiso, preparándose): solo sus estadísticas.
  const readOnly = useReadOnlyTeam(loadedTeamId ?? '');
  const link = useTeamLink(loadedTeamId);

  if (data.error) return <p className="form-error">{data.error}</p>;
  if (data.data === undefined) return <div className="screen" />;
  if (data.data === null || !data.data.team) {
    return (
      <div className="content">
        <p className="form-error">Partido no encontrado.</p>
        <button type="button" className="btn" onClick={() => navigate({ name: 'teams' })}>
          Volver
        </button>
      </div>
    );
  }
  const { match, events, team } = data.data;
  if (readOnly) {
    return <ReadOnlyMatch match={match} events={events} team={team} notice="Este equipo está bloqueado en este dispositivo: aquí no se registra ni se corrige nada." />;
  }
  // Partido en curso que registra otro dispositivo: se sigue en directo, sin escrituras que choquen.
  const active = match.status === 'in_progress' || match.status === 'halftime';
  if (active && link?.controlledElsewhere?.includes(match.id)) {
    return (
      <ReadOnlyMatch
        match={match}
        events={events}
        team={team}
        live
        notice="Este partido lo está registrando otro dispositivo del equipo. Solo ese dispositivo puede continuarlo; aquí lo ves al día. (Pasar el registro a este dispositivo llegará en una próxima versión.)"
      />
    );
  }
  return <MatchLive key={`${matchId}-${revision}`} initialMatch={match} initialEvents={events} team={team} />;
}

/**
 * Partido solo para consultar: estadísticas, sin registro ni correcciones. Con
 * `live`, recibe los cambios del club cada 5 s mientras está a la vista.
 */
function ReadOnlyMatch({ match, events, team, notice, live = false }: { match: Match; events: MatchEvent[]; team: Team; notice: string; live?: boolean }) {
  const stats = useMemo(() => computeMatchStats(match, events), [match, events]);
  useEffect(() => {
    if (!live || !teamPuller) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void teamPuller?.pull(team.id);
    };
    const timer = setInterval(tick, 5_000);
    return () => clearInterval(timer);
  }, [live, team.id]);
  return (
    <div className="screen">
      <TopBar title={opponentLabel(match.opponent)} subtitle={`${formatDate(match.date)} · ${team.name}`} back={() => navigate({ name: 'team', teamId: team.id })} />
      <main className="content">
        <p className="notice">
          <Icon as={Lock} size={18} />
          {notice}
        </p>
        <StatsView
          mode="match"
          context={`${opponentLabel(match.opponent)} · ${formatDate(match.date)}`}
          redCards={disqualifications(events)}
          team={stats.team}
          rows={match.squad.map((s) => ({ ...s, counters: stats.players.get(s.playerId)! }))}
          intervals={stats.intervals}
          pendingCount={stats.pendingCount}
          summary={<MatchSummaryCard match={match} teamName={publicTeamName(team)} stats={stats} />}
        />
      </main>
    </div>
  );
}

type Tab = 'record' | 'timeline' | 'stats';

const TABS = [
  { value: 'record', label: 'Registro', icon: SquarePen },
  { value: 'timeline', label: 'Cronología', icon: List },
  { value: 'stats', label: 'Estadísticas', icon: ChartColumn },
] as const satisfies readonly { value: Tab; label: string; icon: unknown }[];
type Overlay =
  | { name: 'menu' }
  | { name: 'clock' }
  | { name: 'score' }
  | { name: 'halftime' }
  | { name: 'finish' }
  /** `synced`: el partido ya está en el servidor del club; `auto`: su equipo envía automáticamente. */
  | { name: 'delete'; synced: boolean; auto: boolean }
  | { name: 'edit'; event: MatchEvent }
  | { name: 'add'; timing: EventTiming }
  | { name: 'reduction'; eventId: Id; playerId: Id | null }
  | null;

const upsert = (list: readonly MatchEvent[], e: MatchEvent) =>
  list.some((x) => x.id === e.id) ? list.map((x) => (x.id === e.id ? e : x)) : [...list, e];

function MatchLive({ initialMatch, initialEvents, team }: { initialMatch: Match; initialEvents: MatchEvent[]; team: Team }) {
  const [match, setMatchState] = useState(initialMatch);
  const [events, setEvents] = useState<readonly MatchEvent[]>(initialEvents);
  const [tab, setTab] = useState<Tab>(initialMatch.status === 'finished' ? 'stats' : 'record');
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'pending'>('all');
  const [overlay, setOverlay] = useState<Overlay>(null);

  // Referencia al partido más reciente: el registro toma el tiempo en el instante
  // de la pulsación aunque el reloj se haya pausado o ajustado entretanto.
  const matchRef = useRef(match);
  const setMatch = useCallback((m: Match) => {
    matchRef.current = m;
    setMatchState(m);
  }, []);

  useWakeLock(match.status === 'in_progress' || match.status === 'halftime');

  const stats = useMemo(() => computeMatchStats(match, events), [match, events]);
  const last = useMemo(() => lastRecorded(events), [events]);
  const squad = match.squad;
  // Descalificaciones derivadas de los eventos: se recalculan solas al corregir o borrar.
  const cards = useMemo(() => redCards(events), [events]);
  const disqualified = useMemo(() => new Set(disqualifications(events).keys()), [events]);
  const available = useMemo(() => squad.filter((s) => !disqualified.has(s.playerId)), [squad, disqualified]);
  const unavailable = useMemo(() => squad.filter((s) => disqualified.has(s.playerId)), [squad, disqualified]);

  /** Ejecuta una operación mostrando el error si falla. Devuelve si tuvo éxito. */
  async function attempt(op: () => Promise<void>): Promise<boolean> {
    try {
      await op();
      return true;
    } catch (e) {
      showToast(errorMessage(e), 'error');
      return false;
    }
  }

  const getTiming = useCallback(() => svc.currentTiming(matchRef.current), []);

  const record = (payload: EventPayload, playerId: Id | null, timing: EventTiming) =>
    attempt(async () => {
      const e = await svc.recordEvent(repo, matchRef.current, payload, playerId, timing);
      setEvents((prev) => upsert(prev, e));
      const card = e.playerId === null ? undefined : disqualifications(upsert(events, e)).get(e.playerId);
      const label = `${describePayload(e)} · ${playerLabel(squad, e.playerId, e.kind)}`;
      if (card?.triggerEventId === e.id && card.type === 'accumulated') {
        showToast(`${label} · 3.ª exclusión: roja por acumulación`, 'info');
      } else {
        showToast(label);
      }
    });

  const toggleClock = () =>
    void attempt(async () => setMatch(await svc.toggleClock(repo, matchRef.current)));

  const undo = () =>
    void attempt(async () => {
      const undone = await svc.undoLast(repo, events);
      if (!undone) return;
      setEvents((prev) => upsert(prev, undone));
      showToast(`Deshecho: ${describePayload(undone)} · ${playerLabel(squad, undone.playerId, undone.kind)}`, 'info');
    });

  const saveEdit = (event: MatchEvent, payload: EventPayload, playerId: Id | null, timing: EventTiming) =>
    attempt(async () => {
      const e = await svc.updateEvent(repo, matchRef.current, event, { payload, playerId, ...timing });
      setEvents((prev) => upsert(prev, e));
      showToast('Acción corregida');
    });

  /**
   * Advertencia del editor: ¿el jugador ya estaba descalificado en el minuto de la
   * acción? Solo informa; no crea sanciones ni modifica estadísticas.
   */
  const disqualifiedWarning =
    (existing?: MatchEvent) =>
    (payload: EventPayload, playerId: Id | null, timing: EventTiming): string | null => {
      const candidate = buildEvent({
        id: existing?.id ?? 'accion-nueva',
        matchId: match.id,
        payload,
        playerId,
        timing,
        nowIso: existing?.createdAt ?? new Date().toISOString(),
      });
      const card = actionAfterDisqualification(events, candidate);
      if (!card) return null;
      const who = squad.find((s) => s.playerId === playerId);
      const origin = card.type === 'direct' ? 'roja directa' : 'roja por acumulación';
      return `El dorsal ${who?.number ?? '?'} fue descalificado en el minuto ${formatClock(card.matchTimeMs)} (${origin}). Esta acción corresponde al minuto ${formatClock(timing.matchTimeMs)}.`;
    };

  const remove = (event: MatchEvent) =>
    attempt(async () => {
      const e = await svc.deleteEvent(repo, event);
      setEvents((prev) => upsert(prev, e));
      showToast('Acción eliminada', 'info');
    });

  const changeScore = (adj: ScoreAdjustment) =>
    void attempt(async () => setMatch(await svc.setScoreAdjustment(repo, matchRef.current, adj)));

  const pending = stats.pendingCount;
  const finished = match.status === 'finished';

  return (
    <div className="screen match-screen">
      <ClockHeader
        match={match}
        teamName={publicTeamName(team)}
        score={stats.score}
        events={events}
        squad={squad}
        onReduction={(r) => setOverlay({ name: 'reduction', eventId: r.eventId, playerId: r.playerId })}
        onToggle={toggleClock}
        onMenu={() => setOverlay({ name: 'menu' })}
        onScore={() => setOverlay({ name: 'score' })}
      />

      <main className="match-body">
        {tab === 'record' &&
          (finished ? (
            <div className="content">
              <p className="notice">
                Partido finalizado ({formatDate(match.date)}). Puedes corregir acciones desde la cronología o
                reabrirlo desde el menú ⋮.
              </p>
            </div>
          ) : (
            <>
              <LastActionBar
                last={last}
                squad={squad}
                pendingCount={pending}
                onUndo={undo}
                onPending={() => {
                  setTimelineFilter('pending');
                  setTab('timeline');
                }}
              />
              <RecordPanel squad={available} unavailable={unavailable} getTiming={getTiming} onRecord={record} />
            </>
          ))}
        {tab === 'timeline' && (
          <div className="content">
            <Timeline
              key={timelineFilter}
              events={events}
              squad={squad}
              cards={cards}
              initialFilter={timelineFilter}
              onEdit={(event) => setOverlay({ name: 'edit', event })}
              onAdd={() => setOverlay({ name: 'add', timing: getTiming() })}
            />
          </div>
        )}
        {tab === 'stats' && (
          <div className="content">
            <StatsView
              mode="match"
              context={`${opponentLabel(match.opponent)} · ${formatDate(match.date)}`}
              redCards={disqualifications(events)}
              team={stats.team}
              rows={squad.map((s) => ({ ...s, counters: stats.players.get(s.playerId)! }))}
              intervals={stats.intervals}
              pendingCount={pending}
              summary={<MatchSummaryCard match={match} teamName={publicTeamName(team)} stats={stats} />}
            />
          </div>
        )}
      </main>

      <nav className="tabbar" aria-label="Vista del partido">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className="tab"
            aria-current={tab === t.value ? 'page' : undefined}
            onClick={() => {
              if (t.value === 'timeline') setTimelineFilter('all');
              setTab(t.value);
            }}
          >
            <Icon as={t.icon} size={22} />
            {t.label}
            {t.value === 'timeline' && pending > 0 && <span className="badge">{pending}</span>}
          </button>
        ))}
      </nav>

      {overlay?.name === 'menu' && (
        <MatchMenuSheet
          match={match}
          pendingCount={pending}
          onClose={() => setOverlay(null)}
          onAdjustClock={() => setOverlay({ name: 'clock' })}
          onScore={() => setOverlay({ name: 'score' })}
          onHalftime={() => setOverlay({ name: 'halftime' })}
          onFinish={() => setOverlay({ name: 'finish' })}
          onReopen={() =>
            void attempt(async () => {
              setMatch(await svc.reopenMatch(repo, matchRef.current));
              setOverlay(null);
              setTab('record');
            })
          }
          onExit={() => navigate({ name: 'team', teamId: match.teamId })}
          onDelete={() =>
            void (async () => {
              // ¿Está ya en el servidor del club? Entonces el aviso es específico.
              const synced = (await clubSync?.isMatchSynced(match.id).catch(() => false)) ?? false;
              const link = synced ? await clubSync?.getLink(match.teamId).catch(() => null) : null;
              setOverlay({ name: 'delete', synced, auto: link?.auto === true });
            })()
          }
        />
      )}
      {overlay?.name === 'clock' && (
        <ClockAdjustSheet
          match={match}
          onClose={() => setOverlay(null)}
          onShift={(d) => void attempt(async () => setMatch(await svc.shiftClock(repo, matchRef.current, d)))}
          onSet={(ms) => attempt(async () => setMatch(await svc.adjustClock(repo, matchRef.current, ms)))}
        />
      )}
      {overlay?.name === 'score' && (
        <ScoreSheet match={match} score={stats.score} onChange={changeScore} onClose={() => setOverlay(null)} />
      )}
      {overlay?.name === 'halftime' && (
        <ConfirmSheet
          title="Descanso"
          message="Se detiene el cronómetro. Al volver, pulsa «Iniciar 2.ª parte» y el reloj arrancará en 30:00."
          confirmLabel="Ir al descanso"
          onCancel={() => setOverlay(null)}
          onConfirm={() =>
            void attempt(async () => {
              setMatch(await svc.startHalftime(repo, matchRef.current));
              setOverlay(null);
            })
          }
        />
      )}
      {overlay?.name === 'finish' && (
        <ConfirmSheet
          title="Finalizar partido"
          message={
            <>
              <p>
                Resultado: <strong>{stats.score.own} – {stats.score.opponent}</strong>
              </p>
              {pending > 0 && (
                <p className="notice">
                  Hay {pending} {pending === 1 ? 'acción' : 'acciones'} sin jugador asignado. Puedes finalizar igualmente
                  y asignarlas después desde la cronología.
                </p>
              )}
              <p>Podrás seguir corrigiendo acciones o reabrir el partido más tarde.</p>
            </>
          }
          confirmLabel="Finalizar"
          danger
          onCancel={() => setOverlay(null)}
          onConfirm={() =>
            void attempt(async () => {
              // Solo se sale cuando el partido ya está guardado como finalizado; si
              // falla, se queda aquí con el aviso de error.
              const finished = await svc.finishMatch(repo, matchRef.current);
              setMatch(finished);
              setOverlay(null);
              showToast('Partido finalizado');
              // La pantalla del equipo se monta de nuevo: abre en «Partidos» y relee la lista.
              navigate({ name: 'team', teamId: finished.teamId });
            })
          }
        />
      )}
      {overlay?.name === 'delete' && (
        <ConfirmSheet
          title="Eliminar partido"
          message={
            <>
              <p>
                <strong>{opponentLabel(match.opponent)}</strong>{' '}
                · {formatDate(match.date)}
              </p>
              <p>
                El partido desaparecerá del historial y dejará de contar en las estadísticas del partido, de los
                jugadores y de la temporada. La plantilla y los demás partidos no cambian.
              </p>
              {overlay.synced && (
                <p className="notice">
                  Este partido ya está en el servidor del club. Al eliminarlo, dejará de aparecer en los móviles de consulta
                  cuando actualicen.{' '}
                  {overlay.auto
                    ? 'El borrado se enviará con el envío automático.'
                    : 'El borrado se enviará la próxima vez que uses «Enviar al servidor».'}{' '}
                  Sus acciones no se borran: se conservan marcadas con el partido.
                </p>
              )}
            </>
          }
          confirmLabel="Eliminar partido"
          danger
          onCancel={() => setOverlay(null)}
          onConfirm={() =>
            void attempt(async () => {
              const synced = overlay.synced;
              await svc.deleteMatch(repo, matchRef.current);
              setOverlay(null);
              // Solo se informa del borrado local: el del club se ve en el estado de sincronización.
              showToast(synced ? 'Partido eliminado en este dispositivo · pendiente de enviar al club' : 'Partido eliminado', 'info');
              navigate({ name: 'team', teamId: matchRef.current.teamId }, { replace: true });
            })
          }
        />
      )}
      {overlay?.name === 'edit' && (
        <EventEditorSheet
          squad={squad}
          disqualified={disqualified}
          event={overlay.event}
          defaultTiming={overlay.event}
          onSave={(payload, playerId, timing) => saveEdit(overlay.event, payload, playerId, timing)}
          checkDisqualified={disqualifiedWarning(overlay.event)}
          onDelete={() => remove(overlay.event)}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.name === 'reduction' && (
        <ReductionSheet
          match={match}
          events={events}
          squad={squad}
          eventId={overlay.eventId}
          playerId={overlay.playerId}
          onToggle={(event, value) =>
            void attempt(async () => {
              const e = await svc.setAddsToPrevious(repo, event, value);
              setEvents((prev) => upsert(prev, e));
              showToast(value ? 'Sumada a la inferioridad anterior' : 'Inferioridad separada', 'info');
            })
          }
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.name === 'add' && (
        <EventEditorSheet
          squad={squad}
          disqualified={disqualified}
          defaultTiming={overlay.timing}
          onSave={record}
          checkDisqualified={disqualifiedWarning()}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}

export function MatchSummaryCard({
  match,
  teamName,
  stats,
}: {
  match: Match;
  teamName: string;
  stats: ReturnType<typeof computeMatchStats>;
}) {
  const s = stats.score;
  const adjusted = s.ownAdjustment !== 0 || s.opponentAdjustment !== 0;
  const [home, away] = match.venue === 'home' ? [teamName, match.opponent] : [match.opponent, teamName];
  const [hg, ag] = match.venue === 'home' ? [s.own, s.opponent] : [s.opponent, s.own];
  return (
    <section className="card result-card">
      <div className="result-line">
        <span>{home}</span>
        <strong>
          {hg} – {ag}
        </strong>
        <span>{away}</span>
      </div>
      <p className="muted">
        {formatDate(match.date)} · {match.venue === 'home' ? 'Local' : 'Visitante'} · {match.season}
      </p>
      {adjusted && (
        <p className="hint">
          Por acciones: {s.ownFromEvents}–{s.opponentFromEvents} · Corrección manual: nosotros{' '}
          {fmtSigned(s.ownAdjustment)}, rival {fmtSigned(s.opponentAdjustment)}
        </p>
      )}
    </section>
  );
}

const fmtSigned = (n: number) => (n > 0 ? `+${n}` : String(n));
