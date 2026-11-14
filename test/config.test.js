import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialsKey, normalizeConfig } from '../src/config.js';

const OK = {
  username: ' jane@example.com ',
  password: ' p@ss word ',
  subscription_key: '0123456789abcdef0123456789abcdef',
  zones: ['north', 'houston'],
};

test('a complete configuration, zones in a fixed order, the password as typed', () => {
  const config = normalizeConfig(OK);
  assert.equal(config.error, undefined);
  assert.equal(config.username, 'jane@example.com');
  assert.equal(config.password, ' p@ss word ');
  assert.deepEqual(config.zones, ['houston', 'north']);
  assert.deepEqual(normalizeConfig({ ...OK, zones: 'west, south,west' }).zones, ['south', 'west']);
});

test('each missing or invalid field is named, never its value', () => {
  const cases = [
    [{ ...OK, username: '' }, 'username_missing'],
    [{ ...OK, username: 'a\nb' }, 'username_invalid'],
    [{ ...OK, password: '' }, 'password_missing'],
    [{ ...OK, password: undefined }, 'password_missing'],
    [{ ...OK, password: 'x\r\ny' }, 'password_invalid'],
    [{ ...OK, subscription_key: '' }, 'key_missing'],
    [{ ...OK, subscription_key: 'abc def' }, 'key_invalid'],
    [{ ...OK, subscription_key: '01234567\r\n89abcdef0123' }, 'key_invalid'],
    [{ ...OK, zones: [] }, 'zones_missing'],
    [{ ...OK, zones: ['dallas'] }, 'zones_invalid'],
    [{ ...OK, username: '', password: '' }, 'username_missing'],
    [{ password: 'secret' }, 'username_missing'],
    [undefined, 'username_missing'],
  ];
  for (const [raw, error] of cases) {
    const config = normalizeConfig(raw);
    assert.equal(config.error, error, JSON.stringify(raw));
    assert.equal(config.password, undefined);
    assert.equal(config.key, undefined);
    assert.equal(credentialsKey(config), '');
  }
});
