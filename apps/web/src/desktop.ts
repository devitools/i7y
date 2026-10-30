import { isTauri } from '@tauri-apps/api/core'

export async function syncDesktopTheme(dark: boolean): Promise<void> {
  if (!isTauri()) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const window = getCurrentWindow()
  await window.setTheme(dark ? 'dark' : 'light')
  if(window.label!=='mcp-approval')await window.setBackgroundColor(dark ? '#18181b' : '#ffffff')
}
