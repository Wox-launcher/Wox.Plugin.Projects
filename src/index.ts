import { Context, Plugin, PluginInitParams, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import * as fs from "fs"
import * as path from "path"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

interface ScanDirectory {
  dirPath: string
  disabled: boolean
}

interface GitProject {
  name: string
  path: string
  icon?: string
}

let api: PublicAPI
let projectsCache: GitProject[] = []
let lastScanTime = 0
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

async function getSettings(ctx: Context): Promise<ScanDirectory[]> {
  const directoriesJson = await api.GetSetting(ctx, "scanDirectories")
  await api.Log(ctx, "Debug", `scanDirectories setting: ${directoriesJson}`)

  let directories: ScanDirectory[] = []
  try {
    directories = JSON.parse(directoriesJson || "[]")
  } catch (error) {
    await api.Log(ctx, "Error", `Failed to parse scanDirectories: ${error}`)
  }

  return directories
}

async function getTranslation(ctx: Context, key: string): Promise<string> {
  const translated = await api.GetTranslation(ctx, key)
  return translated || key
}

async function scanDirectories(ctx: Context, directories: ScanDirectory[]): Promise<GitProject[]> {
  const projects: GitProject[] = []
  const enabledDirs = directories.filter(d => !d.disabled)
  await api.Log(ctx, "Debug", `Scanning ${enabledDirs.length} directories`)

  for (const dir of enabledDirs) {
    try {
      await api.Log(ctx, "Debug", `Scanning directory: ${dir.dirPath}`)
      const dirProjects = await scanDirectory(dir.dirPath)
      await api.Log(ctx, "Debug", `Found ${dirProjects.length} projects in ${dir.dirPath}`)
      projects.push(...dirProjects)
    } catch (error) {
      await api.Log(ctx, "Error", `Failed to scan directory ${dir.dirPath}: ${error}`)
    }
  }

  return projects
}

function getWoxPluginIcon(projectPath: string): string | undefined {
  const pluginJsonPath = path.join(projectPath, "plugin.json")
  if (!fs.existsSync(pluginJsonPath)) {
    return undefined
  }

  try {
    const content = fs.readFileSync(pluginJsonPath, "utf-8")
    const pluginJson = JSON.parse(content)
    if (pluginJson.MinWoxVersion && pluginJson.Icon) {
      let icon = pluginJson.Icon
      // Convert relative paths to absolute
      if (icon.startsWith("relative:")) {
        const relativePath = icon.slice(9)
        const absolutePath = path.join(projectPath, relativePath)
        icon = `absolute:${absolutePath}`
      }
      return icon
    }
  } catch {
    // Ignore errors
  }
  return undefined
}

async function scanDirectory(dirPath: string): Promise<GitProject[]> {
  const projects: GitProject[] = []

  if (!fs.existsSync(dirPath)) {
    return projects
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const fullPath = path.join(dirPath, entry.name)

    // Check if it's a git repository
    if (fs.existsSync(path.join(fullPath, ".git"))) {
      // Check if it's a Wox plugin
      const woxIcon = getWoxPluginIcon(fullPath)
      projects.push({
        name: entry.name,
        path: fullPath,
        icon: woxIcon
      })
    }
  }

  return projects
}

async function ensureCache(ctx: Context): Promise<GitProject[]> {
  const now = Date.now()
  const directories = await getSettings(ctx)

  if (projectsCache.length === 0 || now - lastScanTime > CACHE_DURATION) {
    projectsCache = await scanDirectories(ctx, directories)
    lastScanTime = now
    const scannedMsg = await getTranslation(ctx, "scanned_projects")
    await api.Log(ctx, "Info", scannedMsg.replace("%d", String(projectsCache.length)))
  }
  return projectsCache
}

function filterProjects(projects: GitProject[], search: string): GitProject[] {
  if (!search) {
    return projects
  }

  const lowerSearch = search.toLowerCase()
  return projects.filter(p => p.name.toLowerCase().includes(lowerSearch))
}

function parseIcon(iconString: string, _projectPath: string): WoxImage {
  if (iconString.startsWith("emoji:")) {
    return { ImageType: "emoji", ImageData: iconString.slice(6) }
  } else if (iconString.startsWith("absolute:")) {
    return { ImageType: "absolute", ImageData: iconString.slice(9) }
  } else if (iconString.startsWith("relative:")) {
    return { ImageType: "relative", ImageData: iconString.slice(9) }
  } else if (iconString.startsWith("base64:")) {
    return { ImageType: "base64", ImageData: iconString.slice(7) }
  } else if (iconString.startsWith("svg:")) {
    return { ImageType: "svg", ImageData: iconString.slice(4) }
  } else if (iconString.startsWith("url:")) {
    return { ImageType: "url", ImageData: iconString.slice(4) }
  }
  // Default fallback
  return { ImageType: "emoji", ImageData: "📂" }
}

async function openInVSCode(ctx: Context, projectPath: string): Promise<void> {
  const platform = process.platform
  let command: string

  if (platform === "darwin") {
    command = `open -a "Visual Studio Code" "${projectPath}"`
  } else if (platform === "win32") {
    command = `code "${projectPath}"`
  } else {
    command = `code "${projectPath}"`
  }

  try {
    await execAsync(command)
  } catch (error) {
    await api.Log(ctx, "Error", `Failed to open VSCode: ${error}`)
  }
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    const initMsg = await api.GetTranslation(ctx, "plugin_name")
    await api.Log(ctx, "Info", `${initMsg} initialized`)

    // Listen for setting changes to clear cache
    api.OnSettingChanged(ctx, async (_ctx: Context, key: string, _value: string) => {
      if (key === "scanDirectories") {
        projectsCache = []
        lastScanTime = 0
        await api.Log(_ctx, "Info", "Settings changed, cache cleared")
      }
    })
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const allProjects = await ensureCache(ctx)
    const filtered = filterProjects(allProjects, query.Search)

    const openInVSCodeLabel = await getTranslation(ctx, "open_in_vscode")

    const results: Result[] = filtered.map(project => {
      const icon = project.icon ? parseIcon(project.icon, "") : parseIcon("relative:images/app.svg", "")
      return {
        Title: project.name,
        SubTitle: project.path,
        Icon: icon,
        Actions: [
          {
            Name: openInVSCodeLabel,
            Icon: { ImageType: "relative", ImageData: "images/vscode.svg" },
            IsDefault: true,
            Action: async () => {
              await openInVSCode(ctx, project.path)
            }
          }
        ]
      }
    })

    return results
  }
}
