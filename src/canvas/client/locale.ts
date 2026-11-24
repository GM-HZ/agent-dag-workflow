import { createContext, useContext, useSyncExternalStore } from 'react'
import { canvasText, normalizeCanvasLocale, type CanvasLocale } from './messages.js'

export const CanvasLocaleContext = createContext<CanvasLocale>('en')

export function useCanvasCopy() {
  const language = useContext(CanvasLocaleContext)
  return { language, t: canvasText(language) }
}

export function useCanvasLocale(locale?: string): CanvasLocale {
  const documentLocale = useSyncExternalStore(
    locale === undefined ? subscribeToDocumentLanguage : noSubscription,
    readDocumentLanguage,
    () => undefined,
  )
  return normalizeCanvasLocale(locale ?? documentLocale)
}

function readDocumentLanguage(): string | undefined {
  if (typeof document !== 'undefined' && document.documentElement.lang.trim() !== '') {
    return document.documentElement.lang
  }
  return typeof navigator === 'undefined' ? undefined : navigator.language
}

function subscribeToDocumentLanguage(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  window.addEventListener('languagechange', listener)
  return () => {
    observer.disconnect()
    window.removeEventListener('languagechange', listener)
  }
}

function noSubscription(): () => void {
  return () => {}
}
