import { ChartColumn, List, SquarePen } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../app/errors';
import { repo } from '../../app/repo';
import { navigate } from '../../app/router';
import { showToast } from '../../app/toast';
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

export function MatchScreen({ matchId }: { matchId: Id }) {
  const data = useLoad(async () => {
    const match = await repo.getMatch(matchId);
    if (!match || match.deletedAt) return null;
    const [team, events] = await Promise.all([repo.getTeam(match.teamId), repo.listEvents(match.id)]);
    return { match, team, events };
  }, [matchId]);

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
  return <MatchLive key={matchId} initialMatch={data.data.match} initialEvents={data.data.events} team={data.data.team} />;
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
  | { name: 'delete' }
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
          onDelete={() => setOverlay({ name: 'delete' })}
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
            </>
          }
          confirmLabel="Eliminar partido"
          danger
          onCancel={() => setOverlay(null)}
          onConfirm={() =>
            void attempt(async () => {
              await svc.deleteMatch(repo, matchRef.current);
              setOverlay(null);
              showToast('Partido eliminado', 'info');
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

function MatchSummaryCard({
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
