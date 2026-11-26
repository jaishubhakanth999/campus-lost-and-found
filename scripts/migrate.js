#!/usr/bin/env node
'use strict';
const { buildConfig } = require('../src/config/env');
try { buildConfig(process.env); } catch (err) { console.error(err.message); process.exit(1); }
const { migrate } = require('../src/db/migrate');
const { close } = require('../src/db/pool');
migrate()
  .then(() => close())
  .then(() => process.exit(0))
  .catch((err) => { console.error(err.message); process.exit(1); });
