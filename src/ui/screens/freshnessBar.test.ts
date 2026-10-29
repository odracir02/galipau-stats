// Textos de la barra de estado de la consulta: «En directo» solo con
// seguimiento activo; pausa por tiempo distinta de los errores de conexión.
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TeamSnapshot } from '../../remote/api';
import type { LiveStatus, TeamView } from '../../remote/viewer';
import { FreshnessBar } from './RemoteTeamScreen';

const at = new Date().toISOString();
const view = (live: LiveStatus | null, problem: TeamView['problem'] = null): TeamView => ({
  cached: { teamId: 't', snapshot: {} as TeamSnapshot, fetchedAt: at },
  loading: false,
  problem,
  checkedAt: at,
  live,
});
const text = (v: TeamView, onResume: (() => void) | null = () => undefined) =>
  renderToStaticMarkup(createElement(FreshnessBar, { view: v, onRefresh: null, onResume })).replace(/<[^>]+>/g, ' ');

describe('barra de estado de la consulta', () => {
  it('«En directo» solo mientras se sigue un partido en curso', () => {
    expect(text(view('live'))).toMatch(/En directo · actualizado a las \d\d:\d\d:\d\d/);
    expect(text(view(null))).toMatch(/Datos del club · actualizados \d\d:\d\d:\d\d/);
    expect(text(view(null))).not.toMatch(/En directo/);
  });

  it('pausa por tiempo: aviso propio y «Reanudar directo», sin aviso de conexión', () => {
    const t = text(view('paused'));
    expect(t).toMatch(/Actualización automática pausada · datos de las/);
    expect(t).toMatch(/Reanudar directo/);
    expect(t).not.toMatch(/Sin conexión|desactualizados/);
    expect(text(view('live'))).not.toMatch(/Reanudar directo/);
  });

  it('errores de conexión y datos antiguos se distinguen de la pausa', () => {
    expect(text(view('offline', 'offline'))).toMatch(/Sin conexión · datos de las/);
    expect(text(view('offline', 'offline'))).not.toMatch(/Reanudar directo|pausada/);
    expect(text(view('stale', 'server'))).toMatch(/Datos desactualizados/);
  });
});
