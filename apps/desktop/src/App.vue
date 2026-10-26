<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { runtimeInfo, type RuntimeInfo } from './services/native';
import UiIcon from './UiIcon.vue';
import brandIconSmall from './assets/soxu-64.png';
import brandIconLarge from './assets/soxu-256.png';

type Page = 'chat' | 'projects' | 'agents';
type Entry = { id: number; role: 'user'; content: string };
type Session = { id: string; title: string; messages: Entry[] };

// M0 UI prototype: local ephemeral state only; Pi RPC is intentionally not simulated.
const page = ref<Page>('chat');
const sessions = ref<Session[]>([]);
const activeSessionId = ref<string | null>(null);
const draft = ref('');
const search = ref('');
const sidebarOpen = ref(true);
const inspectorOpen = ref(true);
const theme = ref<'light' | 'dark'>('light');
const info = ref<RuntimeInfo | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
const isTauri = ref(false);
const activeSession = computed(() => sessions.value.find(s => s.id === activeSessionId.value));
const filteredSessions = computed(() => sessions.value.filter(s => s.title.toLowerCase().includes(search.value.trim().toLowerCase())));
let seq = 0;

function newChat() {
  page.value = 'chat';
  activeSessionId.value = null;
  draft.value = '';
  nextTick(() => composer.value?.focus());
}
function startPage(next: Page) { page.value = next; if (next === 'chat') nextTick(() => composer.value?.focus()); }
function openSession(id: string) { activeSessionId.value = id; startPage('chat'); }
function send() {
  const content = draft.value.trim();
  if (!content || page.value !== 'chat') return;
  if (!activeSession.value) {
    const id = `local-${++seq}`;
    sessions.value.unshift({ id, title: content.slice(0, 34), messages: [] });
    activeSessionId.value = id;
  }
  activeSession.value?.messages.push({ id: ++seq, role: 'user', content });
  draft.value = '';
  nextTick(() => composer.value?.focus());
}
function toggleTheme() { theme.value = theme.value === 'light' ? 'dark' : 'light'; }
function onKeyboard(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newChat(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); sidebarOpen.value = !sidebarOpen.value; }
  if (event.key === 'Escape' && search.value) search.value = '';
}
function onComposerKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
}
onMounted(async () => {
  window.addEventListener('keydown', onKeyboard);
  try { info.value = await runtimeInfo(); isTauri.value = true; } catch { isTauri.value = false; }
});
onUnmounted(() => window.removeEventListener('keydown', onKeyboard));
</script>

<template>
  <div class="app-shell" :data-theme="theme">
    <aside v-if="sidebarOpen" class="sidebar" aria-label="导航侧栏">
      <div class="side-head">
        <button class="brand" type="button" @click="newChat" aria-label="SOXU 首页"><img class="brand-symbol" :src="brandIconSmall" alt="" /><span class="brand-word">SOXU</span><span class="brand-cn">索序</span></button>
        <button class="icon-button side-toggle" type="button" title="收起侧栏 (Ctrl+B)" aria-label="收起侧栏" @click="sidebarOpen=false"><UiIcon name="panel" :size="19"/></button>
      </div>
      <button class="nav-action" type="button" @click="newChat"><UiIcon name="plus"/><span>新对话</span><kbd>Ctrl K</kbd></button>
      <div class="search-field"><UiIcon name="search" :size="17"/><input v-model="search" placeholder="搜索本地对话" aria-label="搜索本地对话" /></div>
      <div class="nav-divider"></div>
      <button class="nav-item" :class="{ chosen: page==='chat' }" @click="startPage('chat')"><UiIcon name="messages"/>对话 <span class="nav-count">{{ sessions.length }}</span></button>
      <button class="nav-item" :class="{ chosen: page==='projects' }" @click="startPage('projects')"><UiIcon name="folder"/>项目</button>
      <button class="nav-item" :class="{ chosen: page==='agents' }" @click="startPage('agents')"><UiIcon name="activity"/>Agent 开发</button>
      <div class="history-heading">最近对话 <span>仅本次会话</span></div>
      <div class="history-list">
        <button v-for="session in filteredSessions" :key="session.id" class="history-item" :class="{ chosen: page==='chat' && activeSessionId===session.id }" @click="openSession(session.id)" :title="session.title">{{ session.title }}</button>
        <p v-if="filteredSessions.length===0" class="history-empty">{{ search ? '没有匹配的对话' : '还没有对话' }}</p>
      </div>
      <div class="side-bottom">
        <div class="status-side"><span class="state-dot"></span> Pi RPC 尚未连接</div>
        <div class="side-bottom-row"><span class="avatar"><img :src="brandIconSmall" alt="" /></span><span class="account-name">本地工作区 <small>SOXU · M0 原型</small></span><button class="icon-button" @click="toggleTheme" :title="theme==='light'?'切换深色':'切换浅色'" :aria-label="theme==='light'?'切换深色':'切换浅色'"><UiIcon :name="theme==='light'?'moon':'sun'" :size="18"/></button></div>
      </div>
    </aside>

    <div class="main-column">
      <header class="app-header">
        <div class="header-start">
          <button v-if="!sidebarOpen" class="icon-button" title="打开侧栏 (Ctrl+B)" aria-label="打开侧栏" @click="sidebarOpen=true"><UiIcon name="panel"/></button>
          <div class="location-title">SOXU <UiIcon name="chevron-down" :size="16"/><span class="light-note">{{ page==='chat' ? '对话' : page==='projects' ? '项目' : 'Agent 开发' }}</span></div>
        </div>
        <div class="header-end"><span class="prototype-indicator">界面原型 · 未连接模型</span><button class="icon-button" @click="inspectorOpen=!inspectorOpen" :aria-label="inspectorOpen?'关闭任务检查器':'打开任务检查器'" :title="inspectorOpen?'关闭任务检查器':'打开任务检查器'"><UiIcon name="panel"/></button></div>
      </header>

      <main class="content-area">
        <template v-if="page==='chat'">
          <div v-if="!activeSession || activeSession.messages.length===0" class="empty-chat">
            <div class="hero-mark"><img :src="brandIconLarge" alt="" /><span class="hero-dot"></span></div>
            <h1>有什么新想法？</h1>
            <p>让想法从一个对话开始。多项目、并行 Agent 与持久会话将在后续里程碑接入。</p>
            <div class="welcome-pills"><span><UiIcon name="messages" :size="16"/> 对话优先</span><span><UiIcon name="activity" :size="16"/> 多 Agent</span><span><UiIcon name="bolt" :size="16"/> 轻量运行</span></div>
          </div>
          <div v-else class="messages-list" aria-label="当前对话"><div v-for="message in activeSession.messages" :key="message.id" class="message-row"><div class="user-message">{{ message.content }}</div></div><div class="preview-message"><UiIcon name="info" :size="16"/> 这是尚未连接 Pi RPC 的界面预览。消息仅保存在当前页面内，不会发送至模型，也不会保存到磁盘。</div></div>
          <div class="composer-area" :class="{ 'composer-bottom': !!activeSession?.messages.length }">
            <div class="composer"><textarea ref="composer" v-model="draft" rows="2" placeholder="向 SOXU 发送消息…" aria-label="消息内容" @keydown="onComposerKey"></textarea><div class="composer-actions"><span class="composer-hint">Enter 发送 · Shift+Enter 换行</span><button type="button" class="send-button" :disabled="!draft.trim()" @click="send" aria-label="添加本地预览消息"><UiIcon name="send" :size="19"/></button></div></div>
            <p class="footnote">SOXU M0 · 本地 UI 演示，不代表 Pi Agent 已连接</p>
          </div>
        </template>
        <section v-else-if="page==='projects'" class="placeholder-view"><div class="placeholder-icon"><UiIcon name="folder" :size="30"/></div><p class="overline">WORKSPACES</p><h1>项目工作区</h1><p>集中组织仓库、Git Worktree、会话和任务。将在 M1 阶段接入实际项目扫描与管理。</p><span class="stage-pill">计划功能 · 尚未实现</span></section>
        <section v-else class="placeholder-view"><div class="placeholder-icon"><UiIcon name="activity" :size="30"/></div><p class="overline">DEVELOPMENT LOOP</p><h1>Agent 开发进度</h1><p>计划展示 Pi Agent 执行阶段、日志、Token 消耗、检查点与 GitHub CI 状态。当前没有连接开发调度器。</p><span class="stage-pill">计划功能 · 尚未实现</span><code class="next-command">pnpm agent:models　·　pnpm agent:doctor</code></section>
      </main>
    </div>

    <aside v-if="inspectorOpen" class="inspector" aria-label="开发检查器">
      <div class="inspector-head"><div><strong>运行检查器</strong><p>工作区概览</p></div><button class="icon-button" aria-label="关闭检查器" @click="inspectorOpen=false"><UiIcon name="close" :size="18"/></button></div>
      <div class="inspector-scroll">
        <div class="inspector-label">连接</div>
        <div class="detail-card"><div class="detail-row"><div class="detail-title"><span class="state-dot"></span> Pi Agent</div><span class="soft-label">未连接</span></div><p>SOXU 产品端尚未实现 Pi RPC 会话桥接。</p><div class="detail-sub"><UiIcon name="code" :size="15"/> {{ isTauri && info ? `${info.appName} ${info.appVersion} · ${info.platform}` : '浏览器预览模式' }}</div></div>
        <div class="inspector-label">开发模型配置</div>
        <div class="detail-card"><div class="model-caption">Developer · Reviewer</div><div class="model-name">magpie <span>/</span> auto/deepseek-v4.1-flash</div><p>这是开发调度器批准的模型路由，需在本机 Pi 验证可用性。</p></div>
        <div class="inspector-label">开发状态</div><div class="check-list"><div><UiIcon name="check" :size="16"/> UI 布局方案已确定</div><div><UiIcon name="clock" :size="16"/> Pi RPC 集成待开发</div><div><UiIcon name="clock" :size="16"/> 多会话与项目管理待开发</div><div><UiIcon name="clock" :size="16"/> 资源基准测试待执行</div></div>
        <div class="inspector-label">本地预览</div><div class="detail-card small-card"><div class="detail-row"><span>当前对话数</span><strong>{{ sessions.length }}</strong></div><div class="detail-row"><span>已连接 Agent</span><strong>0</strong></div><div class="detail-row"><span>实际任务进度</span><strong>未接入</strong></div></div>
      </div>
      <div class="inspector-footer"><UiIcon name="info" :size="15"/> 本面板不展示伪造的实时数据。</div>
    </aside>
  </div>
</template>
