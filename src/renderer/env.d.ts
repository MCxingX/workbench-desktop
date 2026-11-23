import type { WbBridge } from '@shared/types'

declare global {
  interface Window {
    wb: WbBridge
  }
}

export {}
