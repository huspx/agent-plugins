import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../../plugins/omp-magpie/src/config.ts';

const config = (connections: unknown) => parseConfig({ connections: JSON.stringify(connections) });

test('已有 provider 只保存选择而不复制地址或认证', () => {
  assert.deepEqual(config([{ providerId: 'Existing_ALIAS' }]).connections, [{
    providerId: 'Existing_ALIAS',
    createProvider: false,
  }]);
});

test('显式创建保留 bootstrap 地址，认证仍由 OMP 管理', () => {
  assert.deepEqual(
    config([{ providerId: 'new-alias', createProvider: true, baseUrl: 'http://localhost/prefix' }]).connections,
    [{ providerId: 'new-alias', createProvider: true, baseUrl: 'http://localhost/prefix' }],
  );
});

test('严格拒绝所有层级未知字段及明文凭据', () => {
  assert.throws(
    () => parseConfig({ unknown: 'fixture-secret' }),
    error => error instanceof Error && !error.message.includes('fixture-secret'),
  );
  for (const field of ['apiKey', 'typo']) {
    assert.throws(() => config([{ providerId: 'a', [field]: 'fixture-secret' }]), error =>
      error instanceof Error
      && error.message.includes('未知字段') && !error.message.includes('fixture-secret'));
  }
});

test('拒绝非法 JSON、类型、重复 ID 与创建约束', () => {
  for (
    const raw of [{ connections: '[' }, { connections: '{}' }, { connections: [] }, { autoAttach: 'true' }, {
      connections: 'null',
    }]
  ) {
    assert.throws(() => parseConfig(raw), /配置无效/);
  }
  for (
    const rows of [
      [null],
      [{ providerId: '' }],
      [{ providerId: 'a/b' }],
      [{ providerId: 'a b' }],
      [{ providerId: 'a' }, { providerId: 'a' }],
      [{ providerId: 'a', createProvider: 'true' }],
      [{ providerId: 'Upper', createProvider: true, baseUrl: 'http://localhost' }],
      [{ providerId: 'a', createProvider: true }],
      [{ providerId: 'a', createProvider: true, baseUrl: ' ' }],
    ]
  ) assert.throws(() => config(rows), /配置无效/);
});

test('baseUrl 仅供显式创建，普通附加不能另存地址', () => {
  for (const createProvider of [undefined, false]) {
    assert.throws(
      () => config([{ providerId: 'existing', createProvider, baseUrl: 'http://localhost/old' }]),
      /配置无效/,
    );
  }
});
