import { nativeImage, Tray, Menu, app, BrowserWindow } from 'electron'

/** 生成 16x16 托盘位图（BGRA，premultiplied），免外部资源依赖 */
function makeTrayImage(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const cx = 7.5
  const cy = 7.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      const i = (y * size + x) * 4
      if (d <= 7.0) {
        let b = 0xff
        let g = 0x8d
        let r = 0x4c
        if (Math.abs(dx) < 1.2 && dy < 0.5 && dy > -4.5) {
          b = 0xf2
          g = 0xec
          r = 0xe8
        }
        if (Math.abs(dy) < 1.2 && dx < 0.5 && dx > -3.5) {
          b = 0xf2
          g = 0xec
          r = 0xe8
        }
        buf[i] = b
        buf[i + 1] = g
        buf[i + 2] = r
        buf[i + 3] = 0xff
      } else {
        buf[i + 3] = 0
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 1 })
}

let tray: Tray | null = null
let tipText = '工作台'

export interface TrayActions {
  onShow: () => void
  onHide: () => void
  onLock: () => void
  onCheckin: () => void
  onSettings: () => void
  onQuit: () => void
}

export function createTray(actions: TrayActions): Tray {
  tray = new Tray(makeTrayImage())
  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      { label: tipText, enabled: false },
      { type: 'separator' },
      { label: '显示主界面', click: actions.onShow },
      { label: '打卡上班（Ctrl+Alt+K）', click: actions.onCheckin },
      { label: '系统设置…', click: actions.onSettings },
      { type: 'separator' },
      { label: '立即锁定（Ctrl+Alt+L）', click: actions.onLock },
      { label: '隐藏到托盘', click: actions.onHide },
      { type: 'separator' },
      { label: '退出工作台', click: actions.onQuit }
    ])
    tray!.setContextMenu(menu)
  }
  tray.setToolTip(tipText)
  rebuild()
  tray.on('click', () => {
    const wins = BrowserWindow.getAllWindows()
    const w = wins[0]
    if (!w) return
    if (w.isVisible() && w.isFocused()) w.hide()
    else {
      w.show()
      w.focus()
    }
  })
  tray.on('right-click', rebuild)
  return tray
}

/** 托盘提示文字随倒计时更新（悬浮就能看到还剩多久） */
export function setTrayTooltip(text: string): void {
  if (!tray) return
  tipText = text
  tray.setToolTip(text)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export { app }
