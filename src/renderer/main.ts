import { createApp } from 'vue'
import App from './App.vue'
import QuickCapture from './shell/QuickCapture.vue'
import Recovery from './shell/Recovery.vue'
import './styles/tokens.css'
import './styles/base.css'

// 两个特殊入口：
//   ?quick=1    全局快捷键 Ctrl+Alt+T 的快速记事小窗
//   ?recovery=1 库打不开时的数据救援窗口
const params = new URLSearchParams(window.location.search)
const root = params.get('recovery') === '1' ? Recovery : params.get('quick') === '1' ? QuickCapture : App
createApp(root).mount('#app')
