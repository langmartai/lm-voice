'use strict';

const { EventEmitter } = require('node:events');

/**
 * Push-to-talk hotkey. Emits:
 *   'press'   — when the configured key transitions UP→DOWN
 *   'release' — when the configured key transitions DOWN→UP
 *
 * Uses node-global-key-listener for OS-level keyDown/keyUp across all apps.
 */
class Hotkey extends EventEmitter {
  constructor({ key = 'RIGHT CTRL', mode = 'hold' } = {}) {
    super();
    this.key = key;
    this.mode = mode;
    this.listener = null;
    this.isDown = false;
    this.toggleState = false;
  }

  async start() {
    const { GlobalKeyboardListener } = await safeRequire('node-global-key-listener');
    this.listener = new GlobalKeyboardListener();
    this.listener.addListener((e) => this._onEvent(e));
  }

  setKey(key) {
    this.key = key;
    this.isDown = false;
    this.toggleState = false;
  }

  setMode(mode) {
    this.mode = mode;
    this.isDown = false;
    this.toggleState = false;
  }

  _onEvent(e) {
    if (!e || !e.name) return;
    const match = matchKey(e.name, e.rawKey?.name, this.key);
    if (!match) return;

    if (this.mode === 'toggle') {
      if (e.state === 'DOWN' && !this.isDown) {
        this.isDown = true;
        this.toggleState = !this.toggleState;
        if (this.toggleState) this.emit('press');
        else this.emit('release');
      } else if (e.state === 'UP') {
        this.isDown = false;
      }
      return;
    }

    // hold mode
    if (e.state === 'DOWN' && !this.isDown) {
      this.isDown = true;
      this.emit('press');
    } else if (e.state === 'UP' && this.isDown) {
      this.isDown = false;
      this.emit('release');
    }
  }

  stop() {
    if (this.listener) {
      try { this.listener.kill(); } catch {}
      this.listener = null;
    }
  }
}

function normalize(s) {
  return String(s ?? '').toUpperCase().replace(/[\s_-]+/g, ' ').trim();
}

/**
 * Match any of the common spellings of a key. node-global-key-listener
 * uses names like "RIGHT CTRL", "LEFT ALT", "F12", "CAPS LOCK", "RIGHT META".
 */
function matchKey(name, rawName, configured) {
  const target = normalize(configured);
  const aliases = {
    'RIGHT CTRL': ['RIGHT CTRL', 'RIGHTCTRL', 'CONTROL_R', 'CTRL R', 'R CTRL'],
    'LEFT CTRL':  ['LEFT CTRL', 'LEFTCTRL', 'CONTROL_L', 'CTRL L', 'L CTRL'],
    'RIGHT ALT':  ['RIGHT ALT', 'RIGHTALT', 'ALT_R', 'ALT GR', 'ALTGR'],
    'LEFT ALT':   ['LEFT ALT', 'LEFTALT', 'ALT_L'],
    'RIGHT META': ['RIGHT META', 'RIGHT SUPER', 'RIGHTSUPER', 'WIN_R', 'WIN R'],
    'LEFT META':  ['LEFT META', 'LEFT SUPER', 'LEFTSUPER', 'WIN_L', 'WIN L', 'WIN'],
    'CAPS LOCK':  ['CAPS LOCK', 'CAPSLOCK', 'CAPS'],
    'SCROLL LOCK': ['SCROLL LOCK', 'SCROLLLOCK'],
    'PAUSE':      ['PAUSE', 'BREAK'],
    'SPACE':      ['SPACE', 'SPACEBAR'],
  };
  const wanted = new Set([target, ...(aliases[target] ?? [])]);
  return wanted.has(normalize(name)) || wanted.has(normalize(rawName));
}

let _cachedRequire = null;
async function safeRequire(name) {
  if (_cachedRequire) return _cachedRequire;
  try {
    _cachedRequire = require(name);
    return _cachedRequire;
  } catch (err) {
    throw new Error(
      `Cannot load '${name}'. Run 'npm install' in the app directory first.\n` +
      `Underlying error: ${err.message}`
    );
  }
}

module.exports = { Hotkey };
