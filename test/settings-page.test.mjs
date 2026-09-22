import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

/** 页面里那段没有打包器的内联脚本（改设置页时最容易碰坏它）。 */
const inlineScript = () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, '页面里应该有一段内联脚本')
  return match[1]
}

test('设置页有版本目录入口，放在高级设置里、复用现有字段样式', () => {
  // 版本目录是长路径，用 .field.wide 占一整行，输入框铺满并带「浏览…」按钮；profile / 端口仍是窄行
  // 标签上带着 data-i18n（静态文案走的是 t() 那条线），所以只认标签文字，不管属性
  assert.match(
    html,
    /<label class="field wide"><span[^>]*>版本目录<\/span>[\s\S]{0,200}?<input id="dataDir" type="text" \/>[\s\S]{0,200}?<button class="ghost" id="pickDir"/,
    '版本目录单独占一行（.field.wide），旁边有目录选择按钮',
  )
  assert.match(html, /post\('\/api\/pick-dir'/, '浏览按钮走 /api/pick-dir')
  assert.match(html, /\.advanced \.field\.wide \{ display: block; \}/, '整行样式存在')
  assert.match(html, /<label class="field"><span[^>]*>启动 profile<\/span><select id="profile">/, 'profile 仍是窄行下拉')
  assert.match(html, /<p class="hint" id="dataDirHint"><\/p>/, '提示行复用 .hint（空内容自动隐藏）')
  // 文本输入框本来就在样式表里，新控件不需要额外 CSS
  assert.match(html, /input\[type=text\], input\[type=number\], select \{/)
})

test('保存时把版本目录一起提交，留空表示不改', () => {
  assert.match(html, /const dirBefore = dataDirEl\.value\.trim\(\)/)
  assert.match(html, /\.\.\.\(dirBefore \? \{ dataDir: dirBefore \} : \{\}\)/)
})

test('读到的设置填进输入框，并说明插件/profile 位置与迁移语义', () => {
  assert.match(html, /if \('dataDir' in data\) \{[\s\S]*?dataDirEl\.value = String\(data\.dataDir \?\? ''\)/)
  // 文案走 t()，家目录用 {home} 占位（界面语言切换后同一句话要能换掉）
  assert.match(
    html,
    /dataDirHint\.textContent = t\('dsh 各版本装在这里[\s\S]{0,80}?\{home\}[\s\S]{0,40}?home: data\.dshHome/,
    '提示行说明各版本装在这里，并把 dsh 家目录填进 {home}',
  )
  assert.match(html, /插件和 profile 仍在/)
  assert.match(html, /已安装的版本不会自动迁移/)
})

test('改过目录的保存提示说明立即生效和不迁移', () => {
  // 末尾斜杠不该误判成"改过"：用户常带着 '\' 保存
  assert.match(html, /const normDir = \(value\) => String\(value \?\? ''\)\.trim\(\)\.replace\(\/\[\\\\\/\]\+\$\/, ''\)/)
  assert.match(html, /normDir\(data\.dataDir\) !== normDir\(dirBefore\)/)
  // 新目录名用 {dir} 占位传进去，别只断言写死了半句
  assert.match(
    html,
    /t\('已保存。版本目录已改为 \{dir\}（立即生效）[\s\S]{0,60}?\{ dir: data\.dataDir \}\)/,
    '提示里用 {dir} 占位，并把新目录填进去',
  )
})

test('内联脚本仍能解析', () => {
  // 只编译不运行：语法坏了这里就炸，运行时的行为靠上面的结构断言看住
  new vm.Script(inlineScript())
})
