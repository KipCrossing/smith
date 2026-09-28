import type { EditorApi } from '../../shared/types'

declare global {
  interface Window {
    api: EditorApi
  }
}

export {}
