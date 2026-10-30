'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('fixed visual console stays open on pointer exit while auto-hide still closes it', () => {
  const peek = read('public/js/modules/10-shell/02-peek-panels-upload.js');

  assert.match(peek, /if \(key === 'fx'\) fxPanelPinned = !fxFabAutoHide;/);
  assert.match(peek, /if \(fxFabAutoHide\) \{\s*if \(inFxFab \|\| inFxPanel \|\| inFxBridge\)/);
  assert.match(peek, /else if \(fpOn && !fxPanelPinned\) setPeek\(fp, false, 'fx'\);/);
});

test('fixed launcher click toggles the panel while explicit close remains available', () => {
  const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
  const preferences = read('public/js/modules/00-state/02-preferences-ui-modes.js');

  assert.match(bindings, /fab\.addEventListener\('click',[\s\S]*?if \(fxFabAutoHide\) return;[\s\S]*?toggleFxPanel\(\);/);
  assert.match(bindings, /if \(force == null\) force = !currentlyOpen;/);
  assert.match(bindings, /fxPanelPinned = false;\s*if \(force === false\) \{/);
  assert.match(preferences, /fxPanelPinned = !fxFabAutoHide && !!\(panel && \(panel\.classList\.contains\('peek'\) \|\| panel\.classList\.contains\('show'\)\)\);/);
});
