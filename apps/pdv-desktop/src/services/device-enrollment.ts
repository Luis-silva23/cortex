import axios from 'axios';
import { API_URL } from './server-config';
import type { DeviceStatusPayload } from './device-state';

/**
 * Identidade deste equipamento perante o servidor (docs/CORTEX/DISPOSITIVOS.md). Na primeira abertura o aplicativo se REGISTRA
 * (POST /api/device/enroll: sem empresa e sem filial — quem vincula é o administrador) e recebe um id e uma CHAVE secreta mostrada uma
 * única vez. A chave fica no armazenamento cifrado do sistema (Electron safeStorage: DPAPI/Keychain/libsecret), nunca em texto puro,
 * e vai junto do id em cada login. IP, MAC e nome do computador são só informação para o administrador reconhecer a máquina.
 * As chamadas daqui usam o axios "puro" (sem token de usuário, sem toast): ainda não há usuário.
 */
const STORAGE_KEY = 'pdv-device-identity';

export interface DeviceIdentity {
  deviceId: string;
  deviceKey: string;
}

let cached: DeviceIdentity | null | undefined;

async function readRaw(): Promise<string | null> {
  if (window.electron?.secureStorage) {
    const r = await window.electron.secureStorage.getItem(STORAGE_KEY);
    return r.success ? r.value ?? null : null;
  }
  return localStorage.getItem(STORAGE_KEY); // navegador de desenvolvimento (sem processo principal para cifrar)
}

async function writeRaw(value: string | null): Promise<void> {
  if (window.electron?.secureStorage) {
    if (value === null) await window.electron.secureStorage.removeItem(STORAGE_KEY);
    else await window.electron.secureStorage.setItem(STORAGE_KEY, value);
    return;
  }
  if (value === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, value);
}

export async function getDeviceIdentity(): Promise<DeviceIdentity | null> {
  if (cached !== undefined) return cached;
  let identity: DeviceIdentity | null = null;
  try {
    const raw = await readRaw();
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.deviceId === 'string' && typeof parsed.deviceKey === 'string') identity = parsed;
  } catch {
    identity = null;
  }
  cached = identity;
  return identity;
}

export async function clearDeviceIdentity(): Promise<void> {
  cached = null;
  await writeRaw(null);
}

/** Registra este equipamento (estado PENDENTE no servidor) e guarda a credencial. Devolve o código para o administrador conferir. */
export async function enrollThisDevice(): Promise<{ identity: DeviceIdentity; enrollmentCode: string }> {
  const info = window.electron ? await window.electron.getDeviceInfo().catch(() => null) : null;
  const deviceName = String(info?.hostname || 'PDV').slice(0, 80).padEnd(2, ' ');
  const response = await axios.post(
    `${API_URL}/api/device/enroll`,
    { deviceName, deviceType: 'POS', ...(info?.macAddress ? { hardwareHint: String(info.macAddress).slice(0, 64) } : {}) },
    { timeout: 15000 }
  );
  const { deviceId, deviceKey, enrollmentCode } = response.data.data;
  const identity: DeviceIdentity = { deviceId, deviceKey };
  await writeRaw(JSON.stringify(identity));
  cached = identity;
  return { identity, enrollmentCode };
}

/** Estado do equipamento no servidor. Rejeita com o erro do axios (401 = credencial não vale; sem `response` = servidor inalcançável). */
export async function fetchDeviceStatus(identity: DeviceIdentity): Promise<DeviceStatusPayload> {
  const response = await axios.post(`${API_URL}/api/device/status`, identity, { timeout: 15000 });
  return response.data.data as DeviceStatusPayload;
}
