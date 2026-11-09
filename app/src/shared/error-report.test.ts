import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEvent, scrubText, type ScrubbableEvent } from './error-report';

test('из текста ошибки убираются пути, адреса, почта и ключи', () => {
  assert.equal(scrubText("ENOENT: no such file, open '/Users/anna/work/app/a.ts'"), "ENOENT: no such file, open '<path>'");
  assert.equal(scrubText('cannot read C:\\Users\\anna\\a.ts'), 'cannot read <path>');
  assert.equal(scrubText('clone https://user:pass@github.com/acme/app.git failed'), 'clone <url> failed');
  assert.equal(scrubText('author anna@example.com'), 'author <email>');
  assert.equal(scrubText('Authorization: Bearer abc.def'), 'Authorization: Bearer <secret>');
  assert.equal(scrubText('bad key sk-ant-1234567890'), 'bad key <secret>');
  assert.equal(scrubText('token=abc123&x=1'), 'token=<secret>&x=1');
});

test('обычный текст ошибки не меняется, длинный обрезается', () => {
  assert.equal(scrubText('Cannot read properties of undefined'), 'Cannot read properties of undefined');
  assert.equal(scrubText('x'.repeat(600)).length, 501);
});

test('из отчёта уходит всё, что описывает пользователя и его действия', () => {
  const event: ScrubbableEvent = {
    server_name: 'annas-mac',
    user: { id: '1' },
    breadcrumbs: [{ message: 'log' }],
    extra: { a: 1 },
    request: { url: 'x' },
    transaction: 'file:///Users/anna',
    contexts: { device: { name: 'Anna MacBook' } },
    message: 'failed at /Users/anna/secret',
    exception: {
      values: [
        {
          value: 'open /Users/anna/project/a.ts',
          stacktrace: {
            frames: [
              {
                filename: '/Users/anna/x.js',
                abs_path: '/Users/anna/x.js',
                vars: { a: 1 },
                context_line: 'code',
                pre_context: ['p'],
                post_context: ['q'],
              },
            ],
          },
        },
      ],
    },
  };
  assert.deepEqual(scrubEvent(event, '/Users/anna'), {
    contexts: { device: {} },
    message: 'failed at <path>',
    exception: {
      values: [{ value: 'open <path>', stacktrace: { frames: [{ filename: '~/x.js', abs_path: '~/x.js' }] } }],
    },
  });
});
