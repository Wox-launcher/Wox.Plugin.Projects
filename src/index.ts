import { Context, Plugin, PluginInitParams, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import * as fs from "fs"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

type GitProvider = "github" | "gitlab"

interface ScanDirectory {
  dirPath: string
  disabled: boolean
}

interface GitProject {
  name: string
  path: string
  icon?: string
  provider?: GitProvider
  projectUrl?: string
}

interface ActionLabels {
  openInVSCode: string
  openInGithub: string
  openInGitlab: string
}

let api: PublicAPI
let projectsCache: GitProject[] = []
let lastScanTime = 0
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes
const PROJECT_PATH_CONTEXT_KEY = "projectPath"

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
      const project = await getProjectByPath(fullPath, entry.name)
      if (project) {
        projects.push(project)
      }
    }
  }

  return projects
}

async function getProjectByPath(projectPath: string, projectName?: string): Promise<GitProject | undefined> {
  if (!fs.existsSync(projectPath) || !fs.existsSync(path.join(projectPath, ".git"))) {
    return undefined
  }

  const woxIcon = getWoxPluginIcon(projectPath)
  const projectPage = await getProjectPageInfo(projectPath)

  return {
    name: projectName || path.basename(projectPath),
    path: projectPath,
    icon: woxIcon,
    provider: projectPage?.provider,
    projectUrl: projectPage?.projectUrl
  }
}

async function getProjectPageInfo(projectPath: string): Promise<{ provider: GitProvider; projectUrl: string } | undefined> {
  const remoteUrl = await getRemoteUrl(projectPath)
  if (!remoteUrl) {
    return undefined
  }

  return parseProjectPageUrl(remoteUrl)
}

async function getRemoteUrl(projectPath: string): Promise<string | undefined> {
  const remoteKeys = ["remote.origin.url", "remote.upstream.url"]

  for (const remoteKey of remoteKeys) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", projectPath, "config", "--get", remoteKey])
      const remoteUrl = stdout.trim()
      if (remoteUrl) {
        return remoteUrl
      }
    } catch {
      // Ignore missing remotes and try the next candidate.
    }
  }

  return undefined
}

function parseProjectPageUrl(remoteUrl: string): { provider: GitProvider; projectUrl: string } | undefined {
  const normalizedRemoteUrl = remoteUrl.trim()
  const provider = getGitProvider(normalizedRemoteUrl)
  if (!provider) {
    return undefined
  }

  const projectPath = extractRemoteProjectPath(normalizedRemoteUrl, provider)
  if (!projectPath) {
    return undefined
  }

  return {
    provider,
    projectUrl: `https://${provider}.com/${projectPath}`
  }
}

function getGitProvider(remoteUrl: string): GitProvider | undefined {
  if (remoteUrl.includes("github.com")) {
    return "github"
  }

  if (remoteUrl.includes("gitlab.com")) {
    return "gitlab"
  }

  return undefined
}

function extractRemoteProjectPath(remoteUrl: string, provider: GitProvider): string | undefined {
  const normalizedRemoteUrl = remoteUrl.replace(/\\/g, "/")
  const host = `${provider}.com`

  const protocolMatch = normalizedRemoteUrl.match(new RegExp(`^(?:https?:\\/\\/|ssh:\\/\\/git@)${escapeRegExp(host)}[/:](.+)$`, "i"))
  if (protocolMatch?.[1]) {
    return sanitizeRemoteProjectPath(protocolMatch[1])
  }

  const sshMatch = normalizedRemoteUrl.match(new RegExp(`^(?:git@)?${escapeRegExp(host)}:(.+)$`, "i"))
  if (sshMatch?.[1]) {
    return sanitizeRemoteProjectPath(sshMatch[1])
  }

  return undefined
}

function sanitizeRemoteProjectPath(projectPath: string): string | undefined {
  const normalizedPath = projectPath
    .replace(/\.git$/i, "")
    .replace(/^\//, "")
    .replace(/\/+$/, "")

  return normalizedPath || undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

function parseIcon(iconString: string): WoxImage {
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

function getProjectIcon(project: GitProject): WoxImage {
  if (project.icon) {
    return parseIcon(project.icon)
  }

  if (project.provider === "github") {
    return parseIcon("relative:images/github.svg")
  }

  if (project.provider === "gitlab") {
    return parseIcon("relative:images/gitlab.svg")
  }

  return parseIcon("relative:images/app.svg")
}

function createProjectActions(ctx: Context, project: GitProject, labels: ActionLabels): NonNullable<Result["Actions"]> {
  const contextData = { [PROJECT_PATH_CONTEXT_KEY]: project.path }
  const actions: NonNullable<Result["Actions"]> = [
    {
      Name: labels.openInVSCode,
      Icon: { ImageType: "relative", ImageData: "images/vscode.svg" },
      IsDefault: true,
      ContextData: contextData,
      Action: async () => {
        await openInVSCode(ctx, project.path)
      }
    }
  ]

  if (project.projectUrl && project.provider) {
    actions.push({
      Name: project.provider === "github" ? labels.openInGithub : labels.openInGitlab,
      Icon: { ImageType: "relative", ImageData: project.provider === "github" ? "images/github.svg" : "images/gitlab.svg" },
      Hotkey: "ctrl+enter",
      ContextData: contextData,
      Action: async () => {
        await openProjectPage(ctx, project.projectUrl as string)
      }
    })
  }

  return actions
}

function createProjectResult(ctx: Context, project: GitProject, labels: ActionLabels): Result {
  return {
    Title: project.name,
    SubTitle: project.path,
    Icon: getProjectIcon(project),
    Actions: createProjectActions(ctx, project, labels)
  }
}

async function getActionLabels(ctx: Context): Promise<ActionLabels> {
  const [openInVSCode, openInGithub, openInGitlab] = await Promise.all([getTranslation(ctx, "open_in_vscode"), getTranslation(ctx, "open_in_github"), getTranslation(ctx, "open_in_gitlab")])

  return {
    openInVSCode,
    openInGithub,
    openInGitlab
  }
}

async function restoreProjectResult(ctx: Context, projectPath: string): Promise<Result | null> {
  const project = await getProjectByPath(projectPath)
  if (!project) {
    return null
  }

  const labels = await getActionLabels(ctx)
  return createProjectResult(ctx, project, labels)
}

async function openInVSCode(ctx: Context, projectPath: string): Promise<void> {
  const platform = process.platform

  if (platform === "darwin") {
    try {
      await execFileAsync("open", ["-a", "Visual Studio Code", projectPath])
      return
    } catch (error) {
      await api.Log(ctx, "Error", `Failed to open VSCode: ${error}`)
      return
    }
  }

  try {
    await execFileAsync("code", [projectPath])
  } catch (error) {
    await api.Log(ctx, "Error", `Failed to open VSCode: ${error}`)
  }
}

async function openProjectPage(ctx: Context, projectUrl: string): Promise<void> {
  const platform = process.platform

  try {
    if (platform === "darwin") {
      await execFileAsync("open", [projectUrl])
      return
    }

    if (platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", projectUrl])
      return
    }

    await execFileAsync("xdg-open", [projectUrl])
  } catch (error) {
    await api.Log(ctx, "Error", `Failed to open project page: ${error}`)
  }
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    const initMsg = await api.GetTranslation(ctx, "plugin_name")
    await api.Log(ctx, "Info", `${initMsg} initialized`)

    // Listen for setting changes to clear cache
    await api.OnSettingChanged(ctx, async (_ctx: Context, key: string) => {
      if (key === "scanDirectories") {
        projectsCache = []
        lastScanTime = 0
        await api.Log(_ctx, "Info", "Settings changed, cache cleared")
      }
    })

    await api.OnMRURestore(ctx, async (restoreCtx: Context, mruData) => {
      await api.Log(restoreCtx, "Debug", `MRU restore triggered with context data: ${JSON.stringify(mruData.ContextData)}`)
      const projectPath = mruData.ContextData[PROJECT_PATH_CONTEXT_KEY]
      if (!projectPath) {
        return null
      }

      return restoreProjectResult(restoreCtx, projectPath)
    })
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const allProjects = await ensureCache(ctx)
    const filtered = filterProjects(allProjects, query.Search)

    const labels = await getActionLabels(ctx)
    const results: Result[] = filtered.map(project => createProjectResult(ctx, project, labels))

    return results
  }
}
