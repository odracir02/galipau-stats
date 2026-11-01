import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform, isOtherIosBrowser, listenForInstall } from './install';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('tutorial de instalación: dispositivo', () => {
  it('reconoce iPhone, iPad (también el que se presenta como Mac), Android y lo demás', () => {
    expect(detectPlatform({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })).toBe('ios');
    expect(detectPlatform({ userAgent: IPAD, platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios');
    expect(detectPlatform({ userAgent: IPAD, platform: 'MacIntel', maxTouchPoints: 0 })).toBeNull();
    expect(detectPlatform({ userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe('android');
    expect(detectPlatform({ userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 0 })).toBeNull();
  });

  it('en iPhone distingue Safari de otros navegadores', () => {
    expect(isOtherIosBrowser(IPHONE)).toBe(false);
    expect(isOtherIosBrowser(IPHONE.replace('Version/18.0', 'CriOS/130.0'))).toBe(true);
  });
});

describe('tutorial de instalación: aviso del navegador', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('escucha el aviso y la instalación una sola vez, aunque se llame de nuevo', () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener });
    listenForInstall();
    listenForInstall();
    expect(addEventListener.mock.calls.map(([type]) => type)).toEqual(['beforeinstallprompt', 'appinstalled']);
  });
});
