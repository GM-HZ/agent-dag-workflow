import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Agent DAG Workflow',
  description: '让任意 Agent 用同一份 JSON 驱动可恢复、可审计的 DAG Workflow。',
  base: '/agent-dag-workflow/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#f2eee5' }],
    ['link', { rel: 'icon', href: '/agent-dag-workflow/mark.svg', type: 'image/svg+xml' }],
  ],
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    logo: '/mark.svg',
    siteTitle: 'Agent DAG Workflow',
    nav: [
      { text: '5 分钟开始', link: '/guide/quickstart' },
      { text: 'Agent 接入', link: '/guide/codex' },
      { text: 'Examples', link: '/examples/' },
      { text: '架构', link: '/architecture' },
      {
        text: 'v1.0.0',
        items: [
          { text: 'Template v1 协议', link: 'https://github.com/GM-HZ/agent-dag-workflow/blob/main/spec/workflow-template-v1.md' },
          { text: '发布流程', link: '/release' },
        ],
      },
    ],
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '先选入口', link: '/guide/' },
          { text: '5 分钟快速开始', link: '/guide/quickstart' },
          { text: 'Codex / Skill', link: '/guide/codex' },
        ],
      },
      {
        text: '构建 Workflow',
        items: [
          { text: '创作与发布', link: '/guide/authoring' },
          { text: 'Host Tool / Agent', link: '/host-adapter' },
          { text: '可执行 Examples', link: '/examples/' },
          { text: 'Showcase 说明', link: '/showcase-workflows' },
        ],
      },
      {
        text: '理解系统',
        items: [
          { text: '总体架构', link: '/architecture' },
          { text: 'Core 不变量', link: '/core-hardening' },
          { text: '安全边界', link: '/security' },
          { text: '体验与恢复', link: '/experience' },
        ],
      },
      {
        text: '运行与发布',
        items: [
          { text: '存储与运维', link: '/operations' },
          { text: '验证门禁', link: '/core-verification-harness' },
          { text: '1.0 发布', link: '/release' },
        ],
      },
    ],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: '本页目录' },
    lastUpdated: { text: '最后更新' },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/GM-HZ/agent-dag-workflow' },
    ],
    footer: {
      message: 'Runtime-centered · CLI-native · MCP-gateway · Skill-on-demand · Plugin-packaged',
      copyright: 'MIT License · GM-HZ',
    },
  },
})
