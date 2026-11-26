'use strict';

/**
 * Express application factory. Kept separate from server.js so tests can build
 * the app without opening a port.
 */

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { getConfig } = require('./config/env');
const { limiters } = require('./middleware/rateLimits');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { health } = require('./db/pool');
const logger = require('./lib/logger');

const authRoutes = require('./routes/auth');
const itemRoutes = require('./routes/items');
const claimRoutes = require('./routes/claims');
const adminRoutes = require('./routes/admin');
const fileRoutes = require('./routes/files');

function createApp() {
  const cfg = getConfig();
  const app = express();

  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'media-src': ["'self'", 'blob:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': cfg.isProd ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: cfg.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    })
  );

  if (cfg.CORS_ORIGINS.length) {
    app.use(
      cors({
        origin: cfg.CORS_ORIGINS,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: false,
        maxAge: 600,
      })
    );
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Lightweight request log (no bodies, no headers, no tokens).
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        logger.debug('request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - started,
        });
      }
    });
    next();
  });

  // Health check: reports the database, not just "the process is alive".
  app.get('/api/health', async (req, res) => {
    try {
      const db = await health();
      res.json({
        ok: true,
        service: 'campusconnect',
        env: cfg.NODE_ENV,
        database: { connected: db.ok, latencyMs: db.latencyMs },
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (err) {
      res.status(503).json({ ok: false, service: 'campusconnect', database: { connected: false } });
    }
  });

  app.use('/api', limiters().general);

  app.use('/api/auth', authRoutes);
  app.use('/api/items', itemRoutes);
  app.use('/api/claims', claimRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/files', fileRoutes);

  // Public gallery images (local storage driver only).
  // Claim evidence lives under the same root but is NEVER served from here:
  // it is reachable only through /api/files/private/* which checks the caller.
  app.use('/uploads', (req, res, next) => {
    if (/^\/+private(\/|$)/i.test(req.path)) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }
    return next();
  });
  app.use(
    '/uploads',
    express.static(path.resolve(cfg.LOCAL_UPLOAD_DIR), {
      index: false,
      dotfiles: 'deny',
      maxAge: cfg.isProd ? '7d' : 0,
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
      },
    })
  );

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(
    express.static(publicDir, {
      extensions: ['html'],
      maxAge: cfg.isProd ? '1h' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
