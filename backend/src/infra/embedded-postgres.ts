import { Logger } from '@nestjs/common';
import { mkdir } from 'fs/promises';
import { resolve } from 'path';

const logger = new Logger('Postgres');

export async function startEmbeddedPostgres() {
  if (process.env.USE_EMBEDDED_POSTGRES !== 'true') return;

  const port = Number(process.env.EMBEDDED_PG_PORT ?? 54329);
  const user = process.env.EMBEDDED_PG_USER ?? 'kalimasada';
  const password = process.env.EMBEDDED_PG_PASSWORD ?? 'kalimasada';
  const database = process.env.EMBEDDED_PG_DATABASE ?? 'kalimasada';
  const databaseDir = resolve(process.cwd(), '.data', 'pg');
  await mkdir(databaseDir, { recursive: true });

  const imported = await import('embedded-postgres');
  const EmbeddedPostgres = imported.default;
  const pg = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    persistent: true,
    onLog: () => undefined,
    onError: () => undefined,
  });

  try {
    await pg.initialise();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already|exist|init/i.test(message)) logger.warn(message);
  }

  let started = false;
  let last = '';
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await pg.start();
      started = true;
      break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (/already|running|EADDRINUSE/i.test(last)) {
        started = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    }
  }
  if (!started) throw new Error(`PostgreSQL lokal gagal jalan: ${last}`);

  try {
    await pg.createDatabase(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already|exist/i.test(message)) logger.warn(message);
  }
  logger.log(`PostgreSQL lokal siap di port ${port}`);
}
