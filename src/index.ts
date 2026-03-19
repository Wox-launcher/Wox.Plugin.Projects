import { Context, Plugin, PluginInitParams, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import * as fs from "fs"
import * as https from "https"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { randomUUID } from "crypto"

const execFileAsync = promisify(execFile)

type GitProvider = "github" | "gitlab"

interface ScanDirectory {
  dirPath: string
  disabled: boolean
}

interface GitProject {
  name: string
  path: string
  lastCommitTimestampMs?: number
  provider?: GitProvider
  projectUrl?: string
}

interface ActionLabels {
  openInVSCode: string
  copyPath: string
  openInFileManager: string
  openInGithub: string
  openInGitlab: string
  justNow: string
  minutesAgo: string
  hoursAgo: string
  daysAgo: string
}

interface ProjectCacheState {
  signature: string
  directories: Map<string, GitProject[]>
}

let api: PublicAPI
const PROJECT_PATH_CONTEXT_KEY = "projectPath"
const GITHUB_PAGE_ICON_CACHE = new Map<string, string | null>()
const GITHUB_PAGE_ICON_IN_FLIGHT = new Set<string>()
const SCAN_DIRECTORIES_CONCURRENCY = 4
const SCAN_PROJECTS_CONCURRENCY = 8
const GITHUB_PAGE_REQUEST_TIMEOUT = 1500
const GITHUB_PAGE_MAX_BYTES = 1024 * 1024
let projectCacheState: ProjectCacheState | null = null
let configuredDirectories: ScanDirectory[] = []
let projectCachePromise: Promise<void> | null = null
let projectCacheRefreshVersion = 0
const directoryWatchers = new Map<string, fs.FSWatcher>()
const directoryRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

async function scanDirectoriesToCacheState(ctx: Context, directories: ScanDirectory[]): Promise<ProjectCacheState> {
  const enabledDirs = directories.filter(d => !d.disabled)
  const directoryProjectEntries = await mapWithConcurrency(enabledDirs, SCAN_DIRECTORIES_CONCURRENCY, async dir => {
    try {
      const projects = await scanDirectory(dir.dirPath)
      return [dir.dirPath, projects] as [string, GitProject[]]
    } catch (error) {
      await api.Log(ctx, "Error", `Failed to scan directory ${dir.dirPath}: ${error}`)
      return [dir.dirPath, []] as [string, GitProject[]]
    }
  })

  return {
    signature: getDirectoriesSignature(directories),
    directories: new Map(directoryProjectEntries)
  }
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
  if (!fs.existsSync(dirPath)) {
    return []
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const projectEntries = entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))

  const projects = await mapWithConcurrency(projectEntries, SCAN_PROJECTS_CONCURRENCY, async entry => {
    const fullPath = path.join(dirPath, entry.name)
    if (!fs.existsSync(path.join(fullPath, ".git"))) {
      return undefined
    }

    return await getProjectByPath(fullPath, entry.name)
  })

  return projects.filter((project): project is GitProject => project !== undefined)
}

async function getProjectByPath(projectPath: string, projectName?: string): Promise<GitProject | undefined> {
  if (!fs.existsSync(projectPath) || !fs.existsSync(path.join(projectPath, ".git"))) {
    return undefined
  }

  const [projectPage, lastCommitTimestampMs] = await Promise.all([getProjectPageInfo(projectPath), getLastCommitTimestampMs(projectPath)])

  return {
    name: projectName || path.basename(projectPath),
    path: projectPath,
    lastCommitTimestampMs,
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

async function getLastCommitTimestampMs(projectPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, "log", "-1", "--format=%ct"])
    const timestamp = Number(stdout.trim())
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return undefined
    }

    return timestamp * 1000
  } catch {
    return undefined
  }
}

function formatRelativeTime(timestampMs: number, labels: ActionLabels): string {
  const diffMs = Math.max(0, Date.now() - timestampMs)
  const minutes = Math.floor(diffMs / (60 * 1000))
  if (minutes < 1) {
    return labels.justNow
  }

  if (minutes < 60) {
    return labels.minutesAgo.replace("%d", String(minutes))
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return labels.hoursAgo.replace("%d", String(hours))
  }

  const days = Math.floor(hours / 24)
  return labels.daysAgo.replace("%d", String(days))
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

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) {
    return []
  }

  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex])
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return results
}

function getDirectoriesSignature(directories: ScanDirectory[]): string {
  return JSON.stringify(directories.map(directory => ({ dirPath: directory.dirPath, disabled: directory.disabled })))
}

function flattenCachedProjects(directories: ScanDirectory[], cacheState: ProjectCacheState): GitProject[] {
  const projects: GitProject[] = []
  for (const directory of directories) {
    if (directory.disabled) {
      continue
    }

    const directoryProjects = cacheState.directories.get(directory.dirPath)
    if (directoryProjects) {
      projects.push(...directoryProjects)
    }
  }

  return projects
}

async function loadProjects(ctx: Context): Promise<GitProject[]> {
  if (projectCachePromise) {
    await projectCachePromise
  }

  if (!projectCacheState) {
    await api.Log(ctx, "Warning", "Project cache not initialized, returning empty results")
    return []
  }

  return flattenCachedProjects(configuredDirectories, projectCacheState)
}

async function refreshProjectCache(ctx: Context): Promise<void> {
  const refreshVersion = ++projectCacheRefreshVersion

  if (!projectCachePromise) {
    projectCachePromise = (async () => {
      const startTime = Date.now()
      const directories = await getSettings(ctx)
      await syncDirectoryWatchers(ctx, directories)
      const cacheState = await scanDirectoriesToCacheState(ctx, directories)

      if (refreshVersion !== projectCacheRefreshVersion) {
        return
      }

      configuredDirectories = directories
      projectCacheState = cacheState
      const results = flattenCachedProjects(directories, cacheState)
      const duration = Date.now() - startTime
      await api.Log(ctx, "Info", `Scanned ${directories.length} directories and found ${results.length} projects in ${duration}ms`)
    })().finally(() => {
      projectCachePromise = null
    })
  }

  await projectCachePromise

  if (refreshVersion !== projectCacheRefreshVersion) {
    await refreshProjectCache(ctx)
  }
}

async function syncDirectoryWatchers(ctx: Context, directories: ScanDirectory[]): Promise<void> {
  const enabledDirPaths = new Set(directories.filter(directory => !directory.disabled).map(directory => directory.dirPath))

  for (const [dirPath, watcher] of Array.from(directoryWatchers.entries())) {
    if (enabledDirPaths.has(dirPath)) {
      continue
    }

    watcher.close()
    directoryWatchers.delete(dirPath)
    clearDirectoryRefreshTimer(dirPath)
    if (projectCacheState) {
      projectCacheState.directories.delete(dirPath)
    }
  }

  for (const dirPath of Array.from(enabledDirPaths)) {
    if (directoryWatchers.has(dirPath) || !fs.existsSync(dirPath)) {
      continue
    }

    try {
      const watcher = fs.watch(dirPath, (_eventType: string, filename: string | Buffer | null) => {
        const entryName = filename ? filename.toString() : undefined
        void api.Log(ctx, "Debug", `Directory watcher event: dir=${dirPath}, entry=${entryName || "<unknown>"}`)
        if (!shouldScheduleDirectoryRefresh(dirPath, entryName)) {
          void api.Log(ctx, "Debug", `Directory watcher ignored: dir=${dirPath}, entry=${entryName || "<unknown>"}`)
          return
        }

        void api.Log(ctx, "Debug", `Directory watcher scheduled refresh: dir=${dirPath}, entry=${entryName || "<unknown>"}`)
        scheduleDirectoryRefresh(ctx, dirPath, entryName)
      })
      watcher.on("error", error => {
        void api.Log(ctx, "Error", `Directory watcher failed for ${dirPath}: ${error}`)
      })
      directoryWatchers.set(dirPath, watcher)
    } catch (error) {
      await api.Log(ctx, "Error", `Failed to watch directory ${dirPath}: ${error}`)
    }
  }
}

function clearDirectoryRefreshTimer(dirPath: string): void {
  const timer = directoryRefreshTimers.get(dirPath)
  if (timer) {
    clearTimeout(timer)
    directoryRefreshTimers.delete(dirPath)
  }
}

function shouldScheduleDirectoryRefresh(dirPath: string, filename?: string): boolean {
  if (!filename) {
    return true
  }

  const projectPath = path.join(dirPath, filename)
  const cachedProjects = projectCacheState?.directories.get(dirPath) || []
  if (cachedProjects.some(project => project.path === projectPath)) {
    return true
  }

  try {
    return fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()
  } catch {
    return false
  }
}

function scheduleDirectoryRefresh(ctx: Context, dirPath: string, filename?: string): void {
  clearDirectoryRefreshTimer(dirPath)
  const timer = setTimeout(() => {
    directoryRefreshTimers.delete(dirPath)
    void api.Log(ctx, "Debug", `Directory refresh started: dir=${dirPath}, entry=${filename || "<unknown>"}`)
    void refreshDirectoryCache(ctx, dirPath, filename)
  }, 100)
  directoryRefreshTimers.set(dirPath, timer)
}

async function refreshDirectoryCache(ctx: Context, dirPath: string, filename?: string): Promise<void> {
  if (!projectCacheState || !projectCacheState.directories.has(dirPath)) {
    await api.Log(ctx, "Debug", `Directory refresh skipped, cache bucket missing: dir=${dirPath}, entry=${filename || "<unknown>"}`)
    return
  }

  if (!filename) {
    const nextProjects = await scanDirectory(dirPath)
    projectCacheState.directories.set(dirPath, nextProjects)
    await api.Log(ctx, "Info", `Directory cache fully refreshed: dir=${dirPath}, projects=${nextProjects.length}`)
    return
  }

  const projectPath = path.join(dirPath, filename)
  const currentProjects = projectCacheState.directories.get(dirPath) || []
  const existingIndex = currentProjects.findIndex(project => project.path === projectPath)

  let isDirectory = false
  try {
    isDirectory = fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()
  } catch {
    isDirectory = false
  }

  if (!isDirectory) {
    if (existingIndex >= 0) {
      currentProjects.splice(existingIndex, 1)
      projectCacheState.directories.set(dirPath, [...currentProjects])
      await api.Log(ctx, "Info", `Project removed from cache: dir=${dirPath}, project=${projectPath}, projects=${currentProjects.length}`)
      return
    }
    await api.Log(ctx, "Debug", `Directory refresh ignored missing non-project entry: dir=${dirPath}, entry=${filename}`)
    return
  }

  const project = await getProjectByPath(projectPath, filename)
  if (!project) {
    if (existingIndex >= 0) {
      currentProjects.splice(existingIndex, 1)
      projectCacheState.directories.set(dirPath, [...currentProjects])
      await api.Log(ctx, "Info", `Project removed after validation failure: dir=${dirPath}, project=${projectPath}, projects=${currentProjects.length}`)
      return
    }
    await api.Log(ctx, "Debug", `Directory refresh ignored non-git directory: dir=${dirPath}, entry=${filename}`)
    return
  }

  const nextProjects = [...currentProjects]
  const action = existingIndex >= 0 ? "updated" : "added"
  if (existingIndex >= 0) {
    nextProjects.splice(existingIndex, 1, project)
  } else {
    nextProjects.push(project)
  }

  nextProjects.sort((left, right) => left.name.localeCompare(right.name))
  projectCacheState.directories.set(dirPath, nextProjects)
  await api.Log(ctx, "Info", `Project ${action} in cache: dir=${dirPath}, project=${projectPath}, projects=${nextProjects.length}`)
}

function disposeDirectoryWatchers(): void {
  for (const watcher of Array.from(directoryWatchers.values())) {
    watcher.close()
  }
  directoryWatchers.clear()

  for (const timer of Array.from(directoryRefreshTimers.values())) {
    clearTimeout(timer)
  }
  directoryRefreshTimers.clear()
}

function filterProjects(projects: GitProject[], search: string): GitProject[] {
  if (!search) {
    return projects
  }

  const lowerSearch = search.toLowerCase()
  return projects.filter(p => p.name.toLowerCase().includes(lowerSearch))
}

function parseWoxImage(iconString: string): WoxImage {
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

function getProjectIcon(ctx: Context, project: GitProject, resultId: string): WoxImage {
  const woxIcon = getWoxPluginIcon(project.path)
  if (woxIcon) {
    return parseWoxImage(woxIcon)
  }

  const githubPageIcon = getCachedGithubPageIcon(ctx, project, resultId)
  if (githubPageIcon) {
    return parseWoxImage(`url:${githubPageIcon}`)
  }

  if (project.provider === "github") {
    return parseWoxImage("relative:images/github.svg")
  }

  if (project.provider === "gitlab") {
    return parseWoxImage("relative:images/gitlab.svg")
  }

  return parseWoxImage("relative:images/app.svg")
}

function getCachedGithubPageIcon(ctx: Context, project: GitProject, resultId: string): string | undefined {
  if (project.provider !== "github" || !project.projectUrl) {
    return undefined
  }

  if (GITHUB_PAGE_ICON_CACHE.has(project.projectUrl)) {
    return GITHUB_PAGE_ICON_CACHE.get(project.projectUrl) || undefined
  }

  if (!GITHUB_PAGE_ICON_IN_FLIGHT.has(project.projectUrl)) {
    GITHUB_PAGE_ICON_IN_FLIGHT.add(project.projectUrl)
    void warmGithubPageIcon(ctx, project.projectUrl, resultId)
  }

  return undefined
}

async function warmGithubPageIcon(ctx: Context, projectUrl: string, resultId: string): Promise<void> {
  try {
    const html = await fetchText(projectUrl)
    const iconUrl = parseGithubPageIcon(html, projectUrl)
    GITHUB_PAGE_ICON_CACHE.set(projectUrl, iconUrl || null)
    if (iconUrl) {
      await updatePendingProjectIcons(ctx, projectUrl, iconUrl, resultId)
    }
  } catch {
    GITHUB_PAGE_ICON_CACHE.set(projectUrl, null)
  } finally {
    GITHUB_PAGE_ICON_IN_FLIGHT.delete(projectUrl)
  }
}

async function updatePendingProjectIcons(ctx: Context, projectUrl: string, iconUrl: string, resultId: string): Promise<void> {
  const icon = parseWoxImage(`url:${iconUrl}`)
  const updatableResult = await api.GetUpdatableResult(ctx, resultId)
  if (!updatableResult) {
    return
  }

  await api.UpdateResult(ctx, {
    Id: updatableResult.Id,
    Icon: icon
  })
}

async function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Wox.Plugin.Projects"
        }
      },
      response => {
        const statusCode = response.statusCode || 0
        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          response.resume()
          resolve(fetchText(new URL(response.headers.location, url).toString()))
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume()
          reject(new Error(`Unexpected status code: ${statusCode}`))
          return
        }

        const chunks: Buffer[] = []
        let totalLength = 0

        response.on("data", chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalLength += buffer.length
          if (totalLength > GITHUB_PAGE_MAX_BYTES) {
            request.destroy(new Error("Response too large"))
            return
          }
          chunks.push(buffer)
        })
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
        response.on("error", reject)
      }
    )

    request.setTimeout(GITHUB_PAGE_REQUEST_TIMEOUT, () => {
      request.destroy(new Error("Request timed out"))
    })
    request.on("error", reject)
  })
}

function parseGithubPageIcon(html: string, pageUrl: string): string | undefined {
  const avatarPatterns = [/"ownerAvatar":"([^"]+)"/i, /"ownerAvatarUrl":"([^"]+)"/i, /"avatarUrl":"([^"]+)"/i]

  for (const pattern of avatarPatterns) {
    const match = html.match(pattern)
    const iconUrl = normalizeUrl(decodeHtmlJsonString(match?.[1]), pageUrl)
    if (iconUrl) {
      return iconUrl
    }
  }

  return undefined
}

function decodeHtmlJsonString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
}

function normalizeUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined
  }

  try {
    const resolvedUrl = new URL(value, baseUrl)
    if (resolvedUrl.protocol !== "http:" && resolvedUrl.protocol !== "https:") {
      return undefined
    }
    return resolvedUrl.toString()
  } catch {
    return undefined
  }
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
    },
    {
      Name: labels.copyPath,
      Icon: { ImageType: "emoji", ImageData: "📋" },
      ContextData: contextData,
      Action: async () => {
        await copyProjectPath(ctx, project.path)
      }
    },
    {
      Name: labels.openInFileManager,
      Icon: { ImageType: "emoji", ImageData: "🗂️" },
      ContextData: contextData,
      Action: async () => {
        await openInFileManager(ctx, project.path)
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

async function createProjectResult(ctx: Context, project: GitProject, labels: ActionLabels): Promise<Result> {
  const resultId = randomUUID()
  return {
    Id: resultId,
    Title: project.name,
    SubTitle: project.path,
    Icon: getProjectIcon(ctx, project, resultId),
    Tails: createProjectTails(project, labels),
    Actions: createProjectActions(ctx, project, labels),
    Score: project.lastCommitTimestampMs || 0
  }
}

function createProjectTails(project: GitProject, labels: ActionLabels): NonNullable<Result["Tails"]> | undefined {
  if (!project.lastCommitTimestampMs) {
    return undefined
  }

  return [{ Type: "text", Text: formatRelativeTime(project.lastCommitTimestampMs, labels), Id: "last-commit-at" }]
}

async function getActionLabels(ctx: Context): Promise<ActionLabels> {
  const [openInVSCode, copyPath, openInFileManager, openInGithub, openInGitlab, justNow, minutesAgo, hoursAgo, daysAgo] = await Promise.all([
    getTranslation(ctx, "open_in_vscode"),
    getTranslation(ctx, "copy_path"),
    getTranslation(ctx, "open_in_file_manager"),
    getTranslation(ctx, "open_in_github"),
    getTranslation(ctx, "open_in_gitlab"),
    getTranslation(ctx, "just_now"),
    getTranslation(ctx, "minutes_ago"),
    getTranslation(ctx, "hours_ago"),
    getTranslation(ctx, "days_ago")
  ])

  return {
    openInVSCode,
    copyPath,
    openInFileManager,
    openInGithub,
    openInGitlab,
    justNow,
    minutesAgo,
    hoursAgo,
    daysAgo
  }
}

async function restoreProjectResult(ctx: Context, projectPath: string): Promise<Result | null> {
  const project = await getProjectByPath(projectPath)
  if (!project) {
    return null
  }

  const labels = await getActionLabels(ctx)
  return await createProjectResult(ctx, project, labels)
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

  if (platform === "win32") {
    try {
      // Use cmd /c start with /b to open VSCode without showing CMD window
      await execFileAsync("cmd", ["/c", "start", "/b", "code", projectPath])
      return
    } catch (error) {
      await api.Log(ctx, "Error", `Failed to open VSCode: ${error}`)
      return
    }
  }

  // Linux and other platforms
  try {
    await execFileAsync("code", [projectPath])
  } catch (error) {
    await api.Log(ctx, "Error", `Failed to open VSCode: ${error}`)
  }
}

async function copyProjectPath(ctx: Context, projectPath: string): Promise<void> {
  try {
    await api.Copy(ctx, { type: "text", text: projectPath })
  } catch (error) {
    await api.Log(ctx, "Error", `Failed to copy project path: ${error}`)
  }
}

async function openInFileManager(ctx: Context, projectPath: string): Promise<void> {
  const platform = process.platform

  try {
    if (platform === "darwin") {
      await execFileAsync("open", [projectPath])
      return
    }

    if (platform === "win32") {
      await execFileAsync("explorer", [projectPath])
      return
    }

    await execFileAsync("xdg-open", [projectPath])
  } catch (error) {
    await api.Log(ctx, "Error", `Failed to open project in file manager: ${error}`)
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
        projectCacheState = null
        projectCachePromise = null
        configuredDirectories = []
        disposeDirectoryWatchers()
        GITHUB_PAGE_ICON_CACHE.clear()
        GITHUB_PAGE_ICON_IN_FLIGHT.clear()
        await refreshProjectCache(_ctx)
        await api.Log(_ctx, "Info", "Settings changed, cache refreshed")
      }
    })

    await api.OnUnload(ctx, async () => {
      disposeDirectoryWatchers()
    })

    await api.OnMRURestore(ctx, async (restoreCtx: Context, mruData) => {
      await api.Log(restoreCtx, "Debug", `MRU restore triggered with context data: ${JSON.stringify(mruData.ContextData)}`)
      const projectPath = mruData.ContextData[PROJECT_PATH_CONTEXT_KEY]
      if (!projectPath) {
        return null
      }

      return restoreProjectResult(restoreCtx, projectPath)
    })

    void refreshProjectCache(ctx)
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const allProjects = await loadProjects(ctx)
    const filtered = filterProjects(allProjects, query.Search)

    const labels = await getActionLabels(ctx)
    const results = await Promise.all(filtered.map(project => createProjectResult(ctx, project, labels)))

    return results
  }
}
