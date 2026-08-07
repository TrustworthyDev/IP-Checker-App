'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Tiny JSON settings store in Electron's userData dir. Deliberately not
 * electron-store: this is a handful of scalars and we want zero surprises
 * about where the API key lands on disk.
 */

const DEFAULTS = {
  apiKey: '',
  defaultScheme: 'http',
  concurrency: 5,
  timeoutMs: 15000,
  lastList: '',
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Missing or corrupt file is normal on first run -- fall back to defaults.
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = { ...load(), ...patch };

  // Clamp anything that reaches the network layer, so a hand-edited file
  // can't produce a 500-way fan-out or a zero-millisecond timeout.
  next.concurrency = Math.max(1, Math.min(50, Number(next.concurrency) || DEFAULTS.concurrency));
  next.timeoutMs = Math.max(2000, Math.min(120000, Number(next.timeoutMs) || DEFAULTS.timeoutMs));

  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    return { ...next, saveError: error.message };
  }
  return next;
}

module.exports = { load, save, DEFAULTS, settingsPath };
