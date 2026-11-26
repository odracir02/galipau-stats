// Bienvenida, acceso por correo y alta de club.
import { ArrowRight, Building2, KeyRound, Mail, Smartphone } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, createClub, sendCode, signIn } from './api';
import {
  CLUB_NAME_MAX,
  clubHash,
  isCompleteCode,
  isValidEmail,
  needsNewCode,
  normalizeCode,
  normalizeEmail,
  SHORT_NAME_MAX,
  type PublicConfig,
} from './format';
import { useTurnstile } from './turnstile';
import { go } from './nav';
import { ErrorBox } from './ui';

// --- Bienvenida -----------------------------------------------------------------

export function Welcome({ config }: { config: PublicConfig }) {
  return (
    <div className="club-welcome">
      <section className="card club-hero">
        <h2>Gestiona tu club en GalipauStats</h2>
        <p>
          El espacio para quienes dirigen el club: sus equipos, temporadas, códigos de acceso y administradores. Las
          estadísticas de los partidos se siguen tomando en la aplicación deportiva.
        </p>
        <div className="club-hero-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => go('#/entrar')}>
            <Mail size={20} aria-hidden="true" />
            Entrar
          </button>
          <button type="button" className="btn btn-lg" onClick={() => go('#/entrar/crear')} disabled={!config.publicSignup}>
            <Building2 size={20} aria-hidden="true" />
            Crear mi club
          </button>
        </div>
        {!config.publicSignup && <p className="hint">El alta de clubes nuevos abrirá próximamente. Si te han invitado a un club, entra con tu correo.</p>}
      </section>

      <section className="card club-how">
        <h3>
          <KeyRound size={18} aria-hidden="true" />
          Sin contraseñas
        </h3>
        <p className="muted">
          Escribe tu correo y te enviaremos un código de seis cifras que caduca a los cinco minutos. Con él entras en este
          dispositivo durante siete días o hasta que cierres la sesión.
        </p>
      </section>

      {config.appUrl && (
        <a className="card club-app-link" href={config.appUrl} rel="noopener">
          <Smartphone size={20} aria-hidden="true" />
          <span>
            <strong>¿Entrenas o sigues a un equipo?</strong>
            <span className="muted">Si ya tienes un código de equipo, entra en la aplicación deportiva.</span>
          </span>
          <ArrowRight size={18} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

// --- Acceso ------------------------------------------------------------------------

export function Login({ config, then, onSignedIn }: { config: PublicConfig; then: 'home' | 'create'; onSignedIn: () => Promise<void> }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mustResend, setMustResend] = useState(false);
  const { boxRef: captchaBox, token: captchaToken, ready: captchaReady, failed: captchaFailed, enabled: captchaEnabled, consume: consumeCaptcha } = useTurnstile(
    config.turnstileSiteKey,
  );

  const request = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!isValidEmail(email)) return setError('Escribe un correo válido.');
    setBusy(true);
    setError(null);
    try {
      await sendCode(normalizeEmail(email), captchaToken);
      setStep('code');
      setCode('');
      setMustResend(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se ha podido enviar el código.');
    } finally {
      consumeCaptcha();
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!isCompleteCode(code)) return setError('El código tiene seis cifras.');
    setBusy(true);
    setError(null);
    try {
      await signIn(normalizeEmail(email), code, captchaToken);
      await onSignedIn();
      go(then === 'create' ? '#/crear' : '#/');
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setError(apiErr ? apiErr.message : 'No se ha podido entrar.');
      setMustResend(needsNewCode(apiErr?.code));
    } finally {
      consumeCaptcha();
      setBusy(false);
    }
  };

  const turnstileBox = captchaEnabled && <div ref={captchaBox} className="club-turnstile" />;
  const turnstileError = captchaFailed && <ErrorBox message="No se ha podido cargar la comprobación de seguridad. Recarga la página." />;

  if (step === 'email') {
    return (
      <form className="card form club-login" onSubmit={request} noValidate>
        <h2>{then === 'create' ? 'Crea tu club' : 'Entrar'}</h2>
        <p className="muted">
          {then === 'create' ? 'Primero confirma tu correo: te enviaremos un código de seis cifras.' : 'Te enviaremos un código de seis cifras a tu correo.'}
        </p>
        <label>
          Correo electrónico
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            required
            autoFocus
          />
        </label>
        {turnstileBox}
        {turnstileError}
        <ErrorBox message={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email.trim() || !captchaReady}>
          {busy ? 'Enviando…' : 'Enviar código'}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => go('#/')}>
          Volver
        </button>
      </form>
    );
  }

  return (
    <form className="card form club-login" onSubmit={verify} noValidate>
      <h2>Escribe el código</h2>
      <p className="muted">
        Si <strong>{normalizeEmail(email)}</strong> tiene acceso, acabas de recibir un código de seis cifras. Caduca a los cinco
        minutos. Revisa también la carpeta de correo no deseado.
      </p>
      <label>
        Código
        <input
          className="club-code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          value={code}
          onChange={(e) => setCode(normalizeCode(e.target.value))}
          aria-describedby="code-hint"
          autoFocus
        />
      </label>
      <small id="code-hint" className="hint">
        Seis cifras. Tienes tres intentos con cada código.
      </small>
      {turnstileBox}
      {turnstileError}
      <ErrorBox message={error} />
      {!mustResend && (
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !isCompleteCode(code) || !captchaReady}>
          {busy ? 'Comprobando…' : 'Entrar'}
        </button>
      )}
      <button type="button" className={`btn btn-block${mustResend ? ' btn-primary' : ''}`} onClick={() => request()} disabled={busy || !captchaReady}>
        Pedir otro código
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-block"
        onClick={() => {
          setStep('email');
          setError(null);
        }}
      >
        Cambiar de correo
      </button>
    </form>
  );
}

// --- Alta de club --------------------------------------------------------------------

export function CreateClub({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  // El identificador se propone una vez: si se repite el envío, el servidor
  // devuelve el mismo club en lugar de crear otro.
  const requestId = useRef(crypto.randomUUID());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Escribe el nombre del club.');
    setBusy(true);
    setError(null);
    try {
      const res = await createClub({ id: requestId.current, name: name.trim(), shortName: shortName.trim() });
      setCreated({ id: res.club.id, name: res.club.name });
      requestId.current = crypto.randomUUID();
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se ha podido crear el club.');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <section className="card club-done" role="status">
        <h2>Club creado</h2>
        <p>
          <strong>{created.name}</strong> ya existe y tu cuenta es su <strong>propietaria</strong>. Desde el panel podrás
          gestionarlo a medida que lleguen las herramientas.
        </p>
        <button type="button" className="btn btn-primary btn-block" onClick={() => go(clubHash(created.id))}>
          Ir al panel del club
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </section>
    );
  }

  return (
    <form className="card form" onSubmit={submit} noValidate>
      <h2>Datos del club</h2>
      <label>
        Nombre del club
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={CLUB_NAME_MAX} placeholder="Club Balonmano Ejemplo" required autoFocus />
      </label>
      <label>
        Nombre corto (opcional)
        <input value={shortName} onChange={(e) => setShortName(e.target.value)} maxLength={SHORT_NAME_MAX} placeholder="CB Ejemplo" aria-describedby="short-hint" />
      </label>
      <small id="short-hint" className="hint">
        Para cabeceras y listas. Hasta {SHORT_NAME_MAX} caracteres.
      </small>
      <p className="hint">Tu cuenta será la propietaria del club. Más adelante podrás invitar a otros administradores.</p>
      <ErrorBox message={error} />
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !name.trim()}>
        {busy ? 'Creando…' : 'Crear club'}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={() => go('#/')}>
        Cancelar
      </button>
    </form>
  );
}
