import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMIT_TYPES, GITMOJI, validateCommitMessage } from '../check-commit-msg.mjs';

test('all Gitmoji/type mappings are accepted', () => {
  for (const type of COMMIT_TYPES) {
    assert.equal(validateCommitMessage(`${GITMOJI[type]} ${type}(desktop/ui): 测试描述`), null);
  }
});

test('reject mismatched emoji and type', () => {
  assert.match(validateCommitMessage('✨ fix(loop): 解决问题'), /不匹配/);
});

test('reject missing emoji, scope or description', () => {
  for (const message of ['chore(repo): init', '🔧 chore: init', '🔧 chore(repo): ', '🔧 chore(Repo): test']) {
    assert.notEqual(validateCommitMessage(message), null, message);
  }
});

test('allow commit bodies and Chinese descriptions', () => {
  assert.equal(validateCommitMessage('📚 docs(agents): 文档更新\n\n原因：补充约束'), null);
});

test('reject trailing whitespace in header', () => {
  assert.notEqual(validateCommitMessage('✨ feat(desktop): 更新界面 '), null);
});
