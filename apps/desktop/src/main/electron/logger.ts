/** Console + rotating-ish file logger (one file per day under the logs dir). */
import { appendFile } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/util';

export function fileLogger(logsDir: string, debug = false): Logger {
  const file = (): string => join(logsDir, `appubot-${new Date().toISOString().slice(0, 10)}.log`);
  const write = (level: string, msg: string, meta?: unknown): void => {
    let extra = '';
    if (meta !== undefined && meta !== '') {
      try { extra = ' ' + (typeof meta === 'string' ? meta : JSON.stringify(meta)); } catch { extra = ' [unserializable]'; }
    }
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${extra}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    appendFile(file(), line + '\n', () => undefined);
  };
  return {
    debug: (m, meta) => { if (debug) write('DEBUG', m, meta); },
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}
