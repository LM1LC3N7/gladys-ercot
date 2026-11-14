// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTION_TEST } from '../src/app.js';
import {
  ISO_ZONE,
  USER_AGENT,
  VERSION,
  ZONES,
  ZONE_KEYS,
  calendarKey,
  templateKey,
} from '../src/constants.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('one version everywhere, a real semver, never a moving tag', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(VERSION, manifest.version, 'the User-Agent version');
  assert.ok(
    USER_AGENT.startsWith(`gladys-ercot/${manifest.version} (+https://github.com/LM1LC3N7/`),
  );
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-ercot:${manifest.version}`);
  assert.doesNotMatch(manifest.docker_image, /:latest$/);
});

test('the store basics: Texas only, Gladys 5.3 for `countries`', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.3.0');
  assert.deepEqual(manifest.countries, ['US']);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.keywords, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.equal(pkg.license, 'Apache-2.0');
});

test('every text is in English and French; no wording that lies about secrets', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'src/i18n.js',
  ]) {
    assert.doesNotMatch(read(file), /chiffr|encrypt|hachage|hashed/i, file);
  }
});

test('the configuration: two secrets without default, the account, the zones', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'username',
    'password',
    'subscription_key',
    'zones',
  ]);
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/);
  for (const key of ['password', 'subscription_key']) {
    assert.equal(fields[key].type, 'secret');
    assert.equal(fields[key].default, undefined);
    assert.equal(fields[key].required, true);
    assert.match(
      fields[key].description.en,
      /Kept by Gladys in its database, never shown again, sent only to ERCOT/,
    );
    assert.match(
      fields[key].description.fr,
      /Gardée? par Gladys dans sa base, jamais réaffichée?, envoyée? seulement à ERCOT/,
    );
  }
  assert.equal(fields.username.type, 'string');
  assert.equal(fields.username.required, true);
  assert.equal(fields.zones.type, 'multi_select');
  assert.deepEqual(
    fields.zones.options.map((o) => o.value),
    ZONE_KEYS,
  );
  assert.match(fields.intro.description.en, /outside the USA/);
});

test('the action is wired', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    [ACTION_TEST],
  );
  assert.ok(index.includes('onAction(ACTION_TEST'));
  assert.ok(manifest.actions[0].timeout_seconds >= 60, 'a cycle may take a token and 4 zones');
});

test('one calendar and one template per zone, keyed for good', () => {
  const { calendars, templates } = manifest.energy_contracts;
  assert.deepEqual(
    calendars,
    ZONE_KEYS.map((z) => ({
      key: calendarKey(z),
      granularity: 'fifteen_minutes',
      timezone: ISO_ZONE,
      currency: 'USD',
    })),
  );
  assert.deepEqual(
    templates.map((t) => t.key),
    ZONE_KEYS.map(templateKey),
  );
  for (const [i, template] of templates.entries()) {
    const zone = ZONE_KEYS[i];
    assert.equal(template.pricing_mode, 'rules');
    assert.equal(template.currency, 'USD');
    assert.equal(template.country, 'US');
    assert.equal(template.timezone, ISO_ZONE);
    assert.deepEqual(template.calendars, [calendarKey(zone)]);
    assert.ok(template.name.en.includes(zone[0].toUpperCase() + zone.slice(1)));
    assert.ok(template.description.en.includes(ZONES[zone]));
    const [energy] = template.tariff.components;
    assert.equal(energy.rules[0].price_from_calendar, calendarKey(zone));
    // The fallback is the user's own price: never a guess of the module.
    assert.equal(energy.fallback.price, '{{input:fallback_price}}');
    const fallback = template.inputs.find((input) => input.key === 'fallback_price');
    assert.equal(fallback.default, undefined);
    assert.doesNotMatch(calendarKey(zone), /gladys/);
  }
});

test('the devices publish no supported_options (nothing for the core rules to check)', () => {
  const gladys = createFakeGladys({ selector: 'ercot' });
  for (const zone of ZONE_KEYS) {
    const device = buildDevice(gladys, zone);
    assert.equal(device.external_id, `ext:ercot:zone:${zone}`);
    for (const feature of device.features) assert.equal(feature.supported_options, undefined);
  }
});

test('the docs exist in both languages, long enough for the store', () => {
  for (const lang of ['en', 'fr']) {
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md`);
  }
});
