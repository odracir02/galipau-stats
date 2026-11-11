// «Jugadores del club»: identidad común de quien juega en varios equipos. Se
// une ficha a ficha y siempre con confirmación expresa: nunca por nombre ni de
// forma automática. Desvincular no borra nada: cada ficha conserva sus partidos
// y estadísticas en su equipo. Administración normal (no crítica), auditada.
import { Link2, Search, Unlink, UserRound } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ConfirmSheet, Sheet } from '../../src/ui/components/Sheet';
import { api } from './api';
import { canManageClub, type ClubDetail, type Me } from './format';
import { cardTeamLine, linkProblem, searchCards, searchPeople, type CardView, type ClubPeople, type PersonView } from './people';
import { useAction, useData } from './hooks';
import { ActionError, Field, Screen } from './ui';

const put = (playerId: string, personId: string | null, expectedPersonId: string | null) =>
  api(`/api/admin/players/${encodeURIComponent(playerId)}/person`, { method: 'PUT', body: { personId, expectedPersonId } });

function CardLine({ card, children }: { card: CardView; children?: ReactNode }) {
  return (
    <div className="pcard-line">
      <span className="dorsal">{card.number}</span>
      <span className="list-main">
        <strong>{card.name}</strong>
        <span className="muted">
          {cardTeamLine(card)}
          {!card.active && ' · inactiva'}
          {card.rankingExcluded && ' · excluida de los rankings del club'}
        </span>
      </span>
      {children}
    </div>
  );
}

type Confirm = { title: string; message: ReactNode; label: string; danger?: boolean; run: () => Promise<unknown> };

export function PeopleScreen({ me, clubId }: { me: Me; clubId: string }) {
  const club = useData<ClubDetail>(`/api/admin/clubs/${encodeURIComponent(clubId)}`);
  const data = useData<ClubPeople>(`/api/admin/clubs/${encodeURIComponent(clubId)}/people`);
  const action = useAction();
  const [query, setQuery] = useState('');
  const [linking, setLinking] = useState<{ card: CardView } | { person: PersonView } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [renaming, setRenaming] = useState<{ person: PersonView; name: string } | null>(null);
  const back = `#/clubs/${clubId}`;
  const title = 'Jugadores del club';

  if (!canManageClub(me, clubId)) return <Screen title={title} back={back}><p className="form-error">No administras este club.</p></Screen>;
  if (data.error) return <Screen title={title} back={back}><p className="form-error">{data.error}</p></Screen>;
  if (!data.data) return <Screen title={title} subtitle="Cargando…" back={back} />;
  const { people, unlinked } = data.data;
  const shownPeople = searchPeople(people, query);
  const shownCards = searchCards(unlinked, query);

  const done = () => {
    setConfirm(null);
    setRenaming(null);
    data.reload();
  };
  const ask = (c: Confirm) => {
    action.clear();
    setConfirm(c);
  };
  const runConfirm = async () => {
    if (!confirm) return;
    const ok = await action.run(confirm.run);
    // Con error (también un conflicto) se cierra la confirmación y se muestra el aviso: nunca se repite sola.
    setConfirm(null);
    if (ok !== undefined) done();
  };
  const rename = async () => {
    if (!renaming) return;
    const ok = await action.run(() =>
      api(`/api/admin/people/${encodeURIComponent(renaming.person.id)}`, { method: 'PATCH', body: { displayName: renaming.name, expectedVersion: renaming.person.version } }),
    );
    if (ok !== undefined) done();
  };

  return (
    <Screen title={title} subtitle={club.data?.name} back={back}>
      <p className="hint">
        Si alguien juega en varios equipos del club, une aquí sus fichas para que en los rankings del club cuente como una sola
        persona. Cada ficha sigue con sus partidos, dorsal y estadísticas en su equipo. Nada se une solo: siempre lo confirmas tú.
      </p>
      <label className="search">
        <Search size={18} aria-hidden="true" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nombre, equipo o dorsal" aria-label="Buscar jugadores" />
      </label>
      <ActionError action={action} onReload={done} />

      <h2 className="section-title">
        Personas del club <span className="muted">({people.length})</span>
      </h2>
      {people.length === 0 && (
        <div className="empty-card">
          <strong>Todavía no hay ninguna persona</strong>
          <span>Empieza uniendo una ficha sin vincular con la de otro equipo.</span>
        </div>
      )}
      {people.length > 0 && shownPeople.length === 0 && <p className="empty">Ninguna persona coincide con la búsqueda.</p>}
      <ul className="list">
        {shownPeople.map((p) => (
          <li key={p.id} className="card person-card">
            <div className="person-head">
              <UserRound size={20} aria-hidden="true" />
              <strong>{p.displayName}</strong>
              {p.rankingExcluded && <span className="status status-suspended">Excluida de los rankings del club</span>}
            </div>
            {renaming?.person.id === p.id ? (
              <div className="form inline-form">
                <Field label="Nombre visible" hint="Es el nombre que aparece en los rankings del club.">
                  <input value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ person: p, name: e.target.value })} autoFocus />
                </Field>
                <div className="code-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={action.busy || !renaming.name.trim() || renaming.name.trim() === p.displayName} onClick={rename}>
                    Guardar nombre
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>
                    Cancelar
                  </button>
                </div>
              </div>
            ) : null}
            <ul className="card-lines">
              {p.cards.map((c) => (
                <li key={c.playerId}>
                  <CardLine card={c}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        ask({
                          title: 'Desvincular ficha',
                          label: 'Desvincular',
                          danger: true,
                          message: (
                            <>
                              <p>
                                La ficha <strong>{c.name}</strong> ({cardTeamLine(c)}) dejará de contar como <strong>{p.displayName}</strong> en
                                los rankings del club.
                              </p>
                              <p>No se borra nada: sus partidos y estadísticas en el equipo siguen igual.</p>
                            </>
                          ),
                          run: () => put(c.playerId, null, p.id),
                        })
                      }
                    >
                      <Unlink size={16} aria-hidden="true" />
                      Desvincular
                    </button>
                  </CardLine>
                </li>
              ))}
              {p.cards.length === 0 && <li className="muted">Sin fichas vinculadas.</li>}
            </ul>
            <div className="code-actions">
              <button type="button" className="btn btn-sm" onClick={() => (action.clear(), setLinking({ person: p }))}>
                <Link2 size={16} aria-hidden="true" />
                Añadir ficha
              </button>
              <button type="button" className="btn btn-sm" onClick={() => (action.clear(), setRenaming({ person: p, name: p.displayName }))}>
                Cambiar nombre
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  ask({
                    title: p.rankingExcluded ? 'Volver a incluir en los rankings' : 'Excluir de los rankings del club',
                    label: p.rankingExcluded ? 'Incluir' : 'Excluir',
                    message: p.rankingExcluded ? (
                      <p><strong>{p.displayName}</strong> volverá a aparecer en los rankings del club.</p>
                    ) : (
                      <p>
                        <strong>{p.displayName}</strong> no aparecerá en los rankings del club. Sus estadísticas siguen contando en cada equipo.
                      </p>
                    ),
                    run: () => api(`/api/admin/people/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: { rankingExcluded: !p.rankingExcluded, expectedVersion: p.version } }),
                  })
                }
              >
                {p.rankingExcluded ? 'Incluir en rankings' : 'Excluir de rankings'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger-outline"
                onClick={() =>
                  ask({
                    title: 'Eliminar persona',
                    label: 'Eliminar',
                    danger: true,
                    message: (
                      <>
                        <p>
                          Se elimina <strong>{p.displayName}</strong> y se desvinculan sus {p.cards.length} {p.cards.length === 1 ? 'ficha' : 'fichas'}.
                        </p>
                        <p>Las fichas, sus partidos y sus estadísticas no se borran.</p>
                      </>
                    ),
                    run: () => api(`/api/admin/people/${encodeURIComponent(p.id)}/delete`, { method: 'POST', body: { expectedVersion: p.version } }),
                  })
                }
              >
                Eliminar
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2 className="section-title">
        Fichas sin vincular <span className="muted">({unlinked.length})</span>
      </h2>
      {unlinked.length === 0 && <p className="empty">Todas las fichas de jugadores están vinculadas o no hay fichas.</p>}
      {unlinked.length > 0 && shownCards.length === 0 && <p className="empty">Ninguna ficha coincide con la búsqueda.</p>}
      <ul className="list">
        {shownCards.map((c) => (
          <li key={c.playerId} className="card">
            <CardLine card={c}>
              <span className="code-actions">
                <button type="button" className="btn btn-sm" onClick={() => (action.clear(), setLinking({ card: c }))}>
                  <Link2 size={16} aria-hidden="true" />
                  Unir…
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    ask({
                      title: c.rankingExcluded ? 'Volver a incluir la ficha' : 'Excluir la ficha de los rankings del club',
                      label: c.rankingExcluded ? 'Incluir' : 'Excluir',
                      message: (
                        <p>
                          <strong>{c.name}</strong> ({cardTeamLine(c)}) {c.rankingExcluded ? 'volverá a aparecer' : 'no aparecerá'} en los rankings del club. En su equipo
                          sigue igual.
                        </p>
                      ),
                      run: () => api(`/api/admin/players/${encodeURIComponent(c.playerId)}/ranking`, { method: 'PUT', body: { excluded: !c.rankingExcluded } }),
                    })
                  }
                >
                  {c.rankingExcluded ? 'Incluir' : 'Excluir'}
                </button>
              </span>
            </CardLine>
          </li>
        ))}
      </ul>

      {linking && <LinkSheet clubId={clubId} start={linking} data={data.data} onClose={() => setLinking(null)} onDone={() => (setLinking(null), data.reload())} />}
      {confirm && (
        <ConfirmSheet title={confirm.title} message={confirm.message} confirmLabel={action.busy ? 'Guardando…' : confirm.label} danger={confirm.danger} onCancel={() => setConfirm(null)} onConfirm={runConfirm} />
      )}
    </Screen>
  );
}

type Target = { kind: 'person'; person: PersonView } | { kind: 'card'; card: CardView };

/**
 * Unir fichas en tres pasos: la ficha de partida (o la persona), la otra ficha
 * (o una persona existente) y la confirmación expresa con todo a la vista.
 */
function LinkSheet({
  clubId,
  start,
  data,
  onClose,
  onDone,
}: {
  clubId: string;
  start: { card: CardView } | { person: PersonView };
  data: ClubPeople;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const fromCard = 'card' in start ? start.card : null;
  const fromPerson = 'person' in start ? start.person : null;
  const [name, setName] = useState(fromCard?.name ?? '');

  // Qué se une: la persona (existente o nueva) y sus fichas al terminar.
  const person = fromPerson ?? (target?.kind === 'person' ? target.person : null);
  const adding = fromCard ?? (target?.kind === 'card' ? target.card : null);
  const cards = [...(person?.cards ?? []), ...(fromCard ? [fromCard] : []), ...(target?.kind === 'card' ? [target.card] : [])];

  // Opciones del paso 2: fichas sin vincular y, partiendo de una ficha, personas existentes.
  const base = fromPerson ? { cards: fromPerson.cards } : { cards: [fromCard!] };
  const cardOptions = searchCards(data.unlinked, query).filter((c) => c.playerId !== fromCard?.playerId);
  const personOptions = fromCard ? searchPeople(data.people, query) : [];

  const save = async () => {
    const ok = await action.run(async () => {
      if (person && adding) return put(adding.playerId, person.id, null);
      // Persona nueva con las dos fichas, en una sola operación del servidor:
      // o se crea con las dos vinculadas o no cambia nada.
      const other = target?.kind === 'card' ? target.card : null;
      if (!fromCard || !other) return undefined;
      return api(`/api/admin/clubs/${encodeURIComponent(clubId)}/people/pair`, {
        method: 'POST',
        body: { displayName: name, playerIds: [fromCard.playerId, other.playerId] },
      });
    });
    if (ok !== undefined) onDone();
  };

  const footer = target ? (
    <>
      <button type="button" className="btn" onClick={() => (setTarget(null), setConfirmed(false), action.clear())} disabled={action.busy}>
        Atrás
      </button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={!confirmed || action.busy || (!person && !name.trim())}>
        {action.busy ? 'Uniendo…' : 'Unir fichas'}
      </button>
    </>
  ) : undefined;

  return (
    <Sheet title={target ? 'Confirmar: misma persona' : 'Unir fichas'} onClose={onClose} footer={footer}>
      {!target ? (
        <>
          <p className="hint">{fromCard ? 'Ficha de partida:' : `Añadir una ficha a ${fromPerson!.displayName}. Ya tiene:`}</p>
          <ul className="card-lines">
            {base.cards.map((c) => (
              <li key={c.playerId}>
                <CardLine card={c} />
              </li>
            ))}
          </ul>
          <label className="search">
            <Search size={18} aria-hidden="true" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Busca la ficha del otro equipo" aria-label="Buscar la otra ficha" autoFocus />
          </label>
          {personOptions.length > 0 && <h3 className="section-title">Personas del club</h3>}
          <ul className="list">
            {personOptions.map((p) => {
              const problem = linkProblem(fromCard!, p);
              return (
                <li key={p.id}>
                  <button type="button" className="list-item" disabled={!!problem} onClick={() => setTarget({ kind: 'person', person: p })}>
                    <UserRound size={20} aria-hidden="true" />
                    <span className="list-main">
                      <strong>{p.displayName}</strong>
                      <span className="muted">{problem ?? p.cards.map(cardTeamLine).join(' · ')}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <h3 className="section-title">Fichas sin vincular</h3>
          {cardOptions.length === 0 && <p className="empty">Ninguna ficha coincide.</p>}
          <ul className="list">
            {cardOptions.map((c) => {
              const problem = linkProblem(c, base);
              return (
                <li key={c.playerId}>
                  <button type="button" className="list-item" disabled={!!problem} onClick={() => setTarget({ kind: 'card', card: c })}>
                    <span className="dorsal">{c.number}</span>
                    <span className="list-main">
                      <strong>{c.name}</strong>
                      <span className="muted">{problem ?? cardTeamLine(c)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <p>
            {person ? (
              <>
                Estas fichas contarán como <strong>{person.displayName}</strong> en los rankings del club:
              </>
            ) : (
              'Se creará una persona del club con estas dos fichas:'
            )}
          </p>
          <ul className="card-lines confirm-cards">
            {cards.map((c) => (
              <li key={c.playerId}>
                <CardLine card={c} />
              </li>
            ))}
          </ul>
          {!person && (
            <div className="form">
              <Field label="Nombre visible de la persona" hint="Es el nombre que aparecerá en los rankings del club.">
                <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
          )}
          <p className="hint">Cada ficha conserva sus partidos, dorsal y estadísticas en su equipo. Podrás deshacerlo cuando quieras.</p>
          <label className="check confirm-check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Confirmo que estas fichas son de la misma persona
          </label>
          <ActionError action={action} onReload={onDone} />
        </>
      )}
    </Sheet>
  );
}
