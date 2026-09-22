import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseArgs, safeArgs } from '../settings.js'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

test('额外启动参数按空白分词', () => {
  assert.deepEqual(parseArgs('--log-level debug --no-open'), ['--log-level', 'debug', '--no-open'])
  assert.deepEqual(parseArgs('   --a\t1  \n --b 2 '), ['--a', '1', '--b', '2'])
})

test('引号里的空格原样保留', () => {
  assert.deepEqual(parseArgs('--msg "hello world" --x'), ['--msg', 'hello world', '--x'])
  assert.deepEqual(parseArgs("--msg 'a b c'"), ['--msg', 'a b c'])
  // 空字符串也是有意义的参数（比如 --flag ""）
  assert.deepEqual(parseArgs('--flag ""'), ['--flag', ''])
})

test('空输入和未闭合引号都不会炸', () => {
  assert.deepEqual(parseArgs(''), [])
  assert.deepEqual(parseArgs('   '), [])
  assert.deepEqual(parseArgs('--x "a b'), ['--x', 'a b'])
})

test('参数文本有长度上限', () => {
  assert.equal(safeArgs('  --a 1  '), '--a 1')
  assert.equal(safeArgs(undefined), '')
  assert.throws(() => safeArgs('x'.repeat(2001)), /太长/)
})

test('设置页有额外启动参数输入框，并会一起提交/回显', () => {
  // 标签上带着 data-i18n（静态文案走的是 t() 那条线），所以只认标签文字，不管属性
  assert.match(html, /<label class="field wide"><span[^>]*>额外启动参数<\/span><input id="args" type="text"/, '输入框在高级设置里且占一整行')
  assert.match(html, /args: argsEl\.value/, '保存时提交')
  assert.match(html, /if \('args' in data\) argsEl\.value = String\(data\.args \?\? ''\)/, '读设置时回填')
  assert.match(html, /空格分词，含空格的值用引号包起来/, '提示说明分词规则')
})
