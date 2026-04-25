import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  type: 'error' | 'info'
}

interface ToastStore {
  toasts: Toast[]
  push: (message: string, type?: Toast['type']) => void
  dismiss: (id: number) => void
}

let _seq = 0
const TTL_MS = 5000

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (message, type = 'error') => {
    const id = ++_seq
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, TTL_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
