'use strict';

/**
 * CampusConnect server bootstrap.
 *
 * Fails fast on bad configuration, sweeps expired sessions/OTPs on a timer, and
 * shuts down gracefully so a deploy never cuts a request in half.
 */

const { buildConfig } = require('./src/config/env');

let cfg;
try {
  cfg = buildConfig(process.env);
} catch (err) {
  console.error(err.message);
  console.error('\nCopy .env.example to .env and fill in the values above.');
  process.exit(1);
}

const logger = require('./src/lib/logger');
const { createApp } = require('./src/app');
const { health, close } = require('./src/db/pool');
const { sweepSessions } = require('./src/services/authService');

async function main() {
  const db = await health().catch((err) => {
    logger.error('database unreachable at boot', { message: err.message });
    process.exit(1);
  });
  logger.info('database connected', { latencyMs: db.latencyMs });

  const app = createApp();
  const server = app.listen(cfg.PORT, () => {
    logger.info('server listening', { port: cfg.PORT, env: cfg.NODE_ENV, url: cfg.APP_URL });
  });

  // Expire stale sessions and purge old OTP rows.
  const sweep = async () => {
    try {
      const result = await sweepSessions();
      if (result.expiredSessions || result.purgedOtps) logger.info('housekeeping', result);
    } catch (err) {
      logger.warn('housekeeping failed', { message: err.message });
    }
  };
  await sweep();
  const timer = setInterval(sweep, 10 * 60 * 1000);
  timer.unref();

  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    server.close(async () => {
      await close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { message: String(reason) });
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { message: err.message });
  process.exit(1);
});
