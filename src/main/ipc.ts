import { app, dialog, ipcMain, shell as electronShell, BrowserWindow } from 'electron'
import { join } from 'path'
import * as db from './db'
import { getProvider, PROVIDER_IDS } from './providers'
import { costUsd, energyWh } from './providers/pricing'
import type { ProviderId } from './providers/types'
import { AgentRunner } from './agent/runner'
import type { PendingAttachment } from './agent/runner'
import { ShellManager } from './agent/shell'
import { McpManager, parseMcpConfig, type McpServerConfig } from './mcp'
import { AppHostManager, parseAppConfig, type AppConfig } from './apphost'
import { DesktopAppManager, parseDesktopConfig, type DesktopAppConfig } from './desktop/manager'
import * as arena from './arena'
import { deleteImages, saveImage } from './media/store'
import * as vault from './vault'
import * as mtg from './mtg'
import * as edhrec from './edhrec'
import * as cedh from './cedh'
import * as decks from './decks'
import * as forge from './forge'
import * as forgeGame from './forgeGame'
import * as gameSounds from './gameSounds'
import * as retail from './retail'
import * as lifecycle from './lifecycle'
import * as secretlair from './secretlair'
import * as drops from './drops'
import * as alerts from './alerts'
import * as discordAlert from './discordAlert'
import * as tcg from './tcg'
import * as signals from './signals'
import * as discovery from './discovery'
import * as discord from './discord'
import { DiscordBot, type DiscordBotConfigPatch } from './discordBot'
import * as ev from './ev'
import { BrowserManager } from './browser/manager'
import type { FolderMenuItem } from './browser/manager'
import { discoverBookmarkSources, readBookmarkTree } from './browser/bookmarkImport'
import { UnrealClient } from './unreal/client'
import { MediaDock } from './media/dock'
import { htmlToMd, mdToHtml } from './docs/convert'
import * as finance from './finance'
import * as land from './land'
import * as feed from './feed'
import * as agentZoo from './agentZoo'
import { TorrentManager, type AddTorrentInput } from './torrents'

export function registerIpc(win: BrowserWindow): { discordBot: DiscordBot; browser: BrowserManager; runner: AgentRunner; shell: ShellManager; mcp: McpManager; apps: AppHostManager; desktop: DesktopAppManager; torrents: TorrentManager } {
  const browser = new BrowserManager(win)
  const unreal = new UnrealClient()
  const shell = new ShellManager()
  const mcp = new McpManager()
  const notifyAppsChanged = () => { if (!win.isDestroyed()) win.webContents.send('apps:changed', {}) }
  const apps = new AppHostManager(join(app.getPath('userData'), 'apps'), mcp, notifyAppsChanged)
  apps.setConfigs(parseAppConfig(db.getSetting('apps')))
  const desktop = new DesktopAppManager()
  desktop.setConfigs(parseDesktopConfig(db.getSetting('desktop_apps')))

  const runner = new AgentRunner(win, browser, unreal, shell, mcp, apps, desktop)

  // ----- Discord bot (inbound chat → agent) -----
  const discordBot = new DiscordBot(win, runner)
  void discordBot.start()
  ipcMain.handle('discordBot:status', () => discordBot.status())
  ipcMain.handle('discordBot:config', () => discordBot.config())
  ipcMain.handle('discordBot:setConfig', (_e, patch: DiscordBotConfigPatch) => discordBot.setConfig(patch ?? {}))
  ipcMain.handle('discordBot:restart', async () => {
    await discordBot.restart()
    return discordBot.status()
  })
  const media = new MediaDock(win)

  // Connect configured MCP servers in the background; agent runs pick up
  // whatever is connected by the time they start.
  const notifyMcpChanged = () => { if (!win.isDestroyed()) win.webContents.send('mcp:changed', {}) }
  void mcp.connectAll(parseMcpConfig(db.getSetting('mcp_servers'))).then(notifyMcpChanged)

  // ----- MCP servers -----
  ipcMain.handle('mcp:status', () => mcp.statuses())
  ipcMain.handle('mcp:getConfig', () => parseMcpConfig(db.getSetting('mcp_servers')))
  ipcMain.handle('mcp:setConfig', async (_e, servers: McpServerConfig[]) => {
    db.setSetting('mcp_servers', JSON.stringify(servers ?? []))
    await mcp.connectAll(parseMcpConfig(db.getSetting('mcp_servers')))
    notifyMcpChanged()
    return mcp.statuses()
  })
  ipcMain.handle('mcp:reload', async () => {
    await mcp.connectAll(parseMcpConfig(db.getSetting('mcp_servers')))
    notifyMcpChanged()
    return mcp.statuses()
  })

  // ----- app host (launchable apps under test) -----
  ipcMain.handle('apps:status', () => apps.statuses())
  ipcMain.handle('apps:getConfig', () => parseAppConfig(db.getSetting('apps')))
  ipcMain.handle('apps:setConfig', (_e, configs: AppConfig[]) => {
    db.setSetting('apps', JSON.stringify(configs ?? []))
    apps.setConfigs(parseAppConfig(db.getSetting('apps')))
    notifyAppsChanged()
    return apps.statuses()
  })
  ipcMain.handle('apps:launch', (_e, name: string) => apps.launch(name))
  ipcMain.handle('apps:stop', (_e, name: string) => apps.stop(name))
  ipcMain.handle('apps:logs', (_e, name: string, tailChars?: number) => apps.logs(name, tailChars))
  ipcMain.handle('apps:openUi', async (_e, name: string) => {
    const url = apps.uiUrlFor(name)
    if (!url) return false
    browser.setVisible(true)
    await browser.navigate(url)
    return true
  })

  // ----- desktop control (drive existing installed apps) -----
  ipcMain.handle('desktop:status', () => desktop.statuses())
  ipcMain.handle('desktop:getConfig', () => parseDesktopConfig(db.getSetting('desktop_apps')))
  ipcMain.handle('desktop:setConfig', (_e, configs: DesktopAppConfig[]) => {
    db.setSetting('desktop_apps', JSON.stringify(configs ?? []))
    desktop.setConfigs(parseDesktopConfig(db.getSetting('desktop_apps')))
    return desktop.statuses()
  })
  ipcMain.handle('desktop:launch', (_e, name: string) => desktop.launch(name))
  ipcMain.handle('desktop:stop', (_e, name: string) => desktop.stop(name))
  ipcMain.handle('desktop:screenshot', (_e, name: string) => desktop.screenshot(name))
  ipcMain.handle('desktop:click', (_e, name: string, x: number, y: number, button?: 'left' | 'right', doubleClick?: boolean) => desktop.click(name, x, y, button, doubleClick))
  ipcMain.handle('desktop:type', (_e, name: string, text: string, submit?: boolean) => desktop.type(name, text, submit))
  ipcMain.handle('desktop:key', (_e, name: string, keys: string) => desktop.key(name, keys))

  // ----- unreal studio -----
  ipcMain.handle('unreal:status', () => unreal.status())
  ipcMain.handle('unreal:config', () => unreal.config())
  ipcMain.handle('unreal:setConfig', (_e, host?: string, port?: number) => unreal.setConfig(host, port))

  // ----- media dock -----
  ipcMain.handle('media:setOpen', (_e, open: boolean) => media.setOpen(open))
  ipcMain.handle('media:setBounds', (_e, b) => media.setBounds(b))
  ipcMain.handle('media:state', () => media.state())

  // ----- Agent Zoo -----
  ipcMain.handle('agentZoo:list', () => agentZoo.listAgentZoo())
  ipcMain.handle('agentZoo:read', (_e, path: string) => agentZoo.readZooFile(path))
  ipcMain.handle('agentZoo:save', (_e, path: string, content: string) => agentZoo.saveZooFile(path, content))
  ipcMain.handle('agentZoo:createAgent', (_e, input) => agentZoo.createAgentFile(input))

  // ----- sessions -----
  ipcMain.handle('sessions:list', () => db.listSessions())
  ipcMain.handle('sessions:create', (_e, opts) => db.createSession(opts))
  ipcMain.handle('sessions:update', (_e, id, patch) => db.updateSession(id, patch))
  ipcMain.handle('sessions:delete', (_e, id) => {
    // remove the session's image files from disk before the cascade drops the rows
    const files = db.sessionImageFilenames(id)
    db.deleteSession(id)
    if (files.length) deleteImages(files).catch(() => {})
  })
  ipcMain.handle('messages:list', (_e, sessionId) => db.listMessages(sessionId))

  // ----- chat -----
  ipcMain.handle('chat:send', async (_e, sessionId: string, md: string, html: string, attachments?: PendingAttachment[]) => {
    // fire-and-forget: events stream back over chat:event
    runner.send(sessionId, md, html, attachments ?? []).catch(() => {})
  })
  ipcMain.handle('chat:stop', (_e, sessionId: string) => runner.stop(sessionId))
  ipcMain.handle('chat:running', (_e, sessionId: string) => runner.isRunning(sessionId))
  ipcMain.handle('chat:roundtableContinue', (_e, sessionId: string, rounds?: number) => {
    runner.continueRoundtable(sessionId, rounds).catch(() => {})
  })

  // ----- arena (blind model comparison) -----
  ipcMain.handle('arena:start', (_e, opts: { prompt: string; provider_a: string; model_a: string; provider_b: string; model_b: string; is_blind: boolean }) =>
    arena.startComparison(win, opts)
  )
  ipcMain.handle('arena:stop', (_e, id: string) => arena.stopComparison(id))
  ipcMain.handle('arena:vote', (_e, id: string, winner: 'a' | 'b' | 'tie' | 'both_bad') => arena.vote(id, winner))
  ipcMain.handle('arena:list', (_e, limit?: number) => db.listComparisons(limit))
  ipcMain.handle('arena:get', (_e, id: string) => db.getComparison(id))
  ipcMain.handle('arena:delete', (_e, id: string) => db.deleteComparison(id))
  ipcMain.handle('arena:leaderboard', () => arena.leaderboard())

  // ----- providers -----
  ipcMain.handle('providers:list', () => PROVIDER_IDS)
  ipcMain.handle('providers:models', async (_e, providerId: string) => {
    try {
      return { ok: true, models: await getProvider(providerId).listModels() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ----- browser -----
  ipcMain.handle('browser:navigate', (_e, url: string) => browser.navigate(url))
  ipcMain.handle('browser:back', () => browser.goBack())
  ipcMain.handle('browser:forward', () => browser.goForward())
  ipcMain.handle('browser:reload', () => browser.reload())
  ipcMain.handle('browser:devtools', () => browser.toggleDevTools())
  ipcMain.handle('browser:setBounds', (_e, bounds) => browser.setBounds(bounds))
  ipcMain.handle('browser:setVisible', (_e, visible: boolean) => browser.setVisible(visible))
  ipcMain.handle('browser:state', () => browser.state())
  ipcMain.handle('browser:newTab', (_e, url?: string, background?: boolean) => browser.newTab(url, background))
  ipcMain.handle('browser:closeTab', (_e, id: string) => browser.closeTab(id))
  ipcMain.handle('browser:activateTab', (_e, id: string) => browser.activate(id))
  ipcMain.handle('browser:suspend', (_e, on: boolean) => browser.setSuspended(on))
  ipcMain.handle('browser:folderMenu', (_e, items: FolderMenuItem[], x: number, y: number) => browser.popupBookmarkFolder(items, x, y))
  ipcMain.handle('browser:bookmarkSources', () => discoverBookmarkSources())
  ipcMain.handle('browser:bookmarkTree', (_e, profilePath: string) => readBookmarkTree(profilePath))
  ipcMain.handle('browser:capturePage', () => browser.readPage())
  ipcMain.handle('browser:saveAsDoc', async () => {
    const page = await browser.captureArticle()
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const source = `<p><em>Captured from <a href="${esc(page.url)}">${esc(page.url)}</a> — ${new Date().toLocaleString()}</em></p><hr>`
    const doc = db.saveDoc({ title: page.title || page.url, html: source + page.html })
    if (!win.isDestroyed()) win.webContents.send('docs:changed')
    return { id: doc.id, title: doc.title, session_id: doc.session_id, created_at: doc.created_at, updated_at: doc.updated_at }
  })

  // ----- settings -----
  ipcMain.handle('settings:getAll', () => db.getAllSettings())
  ipcMain.handle('settings:set', (_e, key: string, value: string) => db.setSetting(key, value))

  // ----- projects -----
  ipcMain.handle('projects:list', () => db.listProjects())
  ipcMain.handle('projects:create', (_e, name: string, color: string) => db.createProject(name, color))
  ipcMain.handle('projects:delete', (_e, id: string) => db.deleteProject(id))

  // ----- planner -----
  const notifyPlannerChanged = () => win.webContents.send('planner:changed', {})
  ipcMain.handle('planner:events:create', (_e, event) => { const row = db.createCalendarEvent(event); notifyPlannerChanged(); return row })
  ipcMain.handle('planner:events:list', (_e, startAt: number, endAt: number, query?: string) => db.listCalendarEvents(startAt, endAt, query))
  ipcMain.handle('planner:events:update', (_e, id: string, patch) => { db.updateCalendarEvent(id, patch); notifyPlannerChanged() })
  ipcMain.handle('planner:events:delete', (_e, id: string) => { db.deleteCalendarEvent(id); notifyPlannerChanged() })
  ipcMain.handle('planner:todos:create', (_e, todo) => { const row = db.createTodo(todo); notifyPlannerChanged(); return row })
  ipcMain.handle('planner:todos:list', (_e, filter) => db.listTodos(filter))
  ipcMain.handle('planner:todos:update', (_e, id: string, patch) => { db.updateTodo(id, patch); notifyPlannerChanged() })
  ipcMain.handle('planner:todos:complete', (_e, id: string) => { db.completeTodo(id); notifyPlannerChanged() })
  ipcMain.handle('planner:todos:delete', (_e, id: string) => { db.deleteTodo(id); notifyPlannerChanged() })
  ipcMain.handle('planner:reminders:create', (_e, reminder) => { const row = db.createReminder(reminder); notifyPlannerChanged(); return row })
  ipcMain.handle('planner:reminders:list', (_e, startAt?: number, endAt?: number, status?: string) => db.listReminders(startAt, endAt, status))
  ipcMain.handle('planner:reminders:update', (_e, id: string, patch) => { db.updateReminder(id, patch); notifyPlannerChanged() })
  ipcMain.handle('planner:reminders:delete', (_e, id: string) => { db.deleteReminder(id); notifyPlannerChanged() })

  // ----- finance -----
  ipcMain.handle('finance:state', async () => ({
    watchlist: await finance.getWatchlist(),
    portfolio: await finance.getPortfolio(),
    settings: await finance.getFinanceSettings()
  }))
  ipcMain.handle('finance:setWatchlist', (_e, w) => finance.setWatchlist(w))
  ipcMain.handle('finance:setPortfolio', (_e, p) => finance.setPortfolio(p))
  ipcMain.handle('finance:setSettings', (_e, s) => finance.setFinanceSettings(s))
  ipcMain.handle('finance:quotes', (_e, symbols: string[]) => finance.quotes(symbols))
  ipcMain.handle('finance:enrich', (_e, symbols: string[]) => finance.enrich(symbols))
  ipcMain.handle('finance:chart', (_e, symbol: string, range: string, interval: string) => finance.chart(symbol, range, interval))
  ipcMain.handle('finance:fundamentals', (_e, symbol: string) => finance.fundamentals(symbol))
  ipcMain.handle('finance:news', (_e, symbol: string) => finance.news(symbol))
  ipcMain.handle('finance:log', (_e, entry) => finance.logActivity(entry))
  ipcMain.handle('finance:activity', (_e, limit?: number) => finance.readActivity(limit))
  ipcMain.handle('finance:appendHistory', (_e, symbol: string, snap) => finance.appendHistory(symbol, snap))
  ipcMain.handle('finance:history', (_e, symbol: string) => finance.getHistory(symbol))
  ipcMain.handle('finance:analyze', async (_e, opts: { provider: string; model: string; system: string; prompt: string }) => {
    try {
      const provider = getProvider(opts.provider)
      const result = await provider.chat({
        model: opts.model,
        system: opts.system,
        messages: [{ role: 'user', content: opts.prompt }],
        tools: [],
        handlers: { onTextDelta: () => {} }
      })
      // Meter the one-shot call so usage totals stay accurate.
      db.addUsage({
        session_id: null,
        project_id: null,
        provider: opts.provider,
        model: opts.model,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cache_read_tokens: result.usage.cacheReadTokens,
        cache_write_tokens: result.usage.cacheWriteTokens,
        cost_usd: costUsd(opts.provider as ProviderId, opts.model, result.usage),
        energy_wh: energyWh(opts.model, result.usage)
      })
      return { ok: true, text: result.text }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ----- feed (news aggregator) -----
  const notifyFeedChanged = () => { if (!win.isDestroyed()) win.webContents.send('feed:changed', {}) }
  ipcMain.handle('feed:sources:list', () => db.listFeedSources())
  ipcMain.handle('feed:sources:add', async (_e, input: string, category?: string | null) => {
    const source = await feed.addSource(input, category)
    notifyFeedChanged()
    return source
  })
  ipcMain.handle('feed:sources:update', (_e, id: string, patch) => { db.updateFeedSource(id, patch); notifyFeedChanged() })
  ipcMain.handle('feed:sources:remove', (_e, id: string) => { db.deleteFeedSource(id); notifyFeedChanged() })
  ipcMain.handle('feed:unreadCounts', () => db.feedUnreadCounts())
  ipcMain.handle('feed:refresh', async (_e, sourceId?: string) => {
    const r = sourceId ? await feed.refreshSource(sourceId) : await feed.refreshAll()
    notifyFeedChanged()
    return r
  })
  ipcMain.handle('feed:items', (_e, opt) => db.listFeedItems(opt))
  ipcMain.handle('feed:item:setState', (_e, id: string, patch) => { db.setFeedItemState(id, patch); notifyFeedChanged() })
  ipcMain.handle('feed:markRead', (_e, sourceId?: string) => { db.markFeedRead(sourceId); notifyFeedChanged() })
  ipcMain.handle('feed:openItem', async (_e, id: string) => {
    const item = db.getFeedItem(id)
    if (!item) return
    db.setFeedItemState(id, { is_read: true })
    browser.setVisible(true)
    await browser.navigate(item.url)
    notifyFeedChanged()
  })

  // ----- vault (collectibles) -----
  const notifyVaultChanged = () => { if (!win.isDestroyed()) win.webContents.send('vault:changed', {}) }
  ipcMain.handle('vault:items', () => db.listVaultItems())
  ipcMain.handle('vault:item:create', (_e, input) => {
    const item = db.createVaultItem(input)
    notifyVaultChanged()
    return item
  })
  ipcMain.handle('vault:item:update', (_e, id: string, patch) => {
    db.updateVaultItem(id, patch)
    notifyVaultChanged()
    return db.getVaultItem(id)
  })
  ipcMain.handle('vault:item:delete', (_e, id: string) => {
    const item = db.getVaultItem(id)
    db.deleteVaultItem(id)
    if (item?.photos.length) deleteImages(item.photos.map((p) => p.filename)).catch(() => {})
    notifyVaultChanged()
  })
  ipcMain.handle('vault:item:addPhoto', async (_e, id: string, photo: { dataBase64: string; mime: string; name?: string }) => {
    const item = db.getVaultItem(id)
    if (!item) throw new Error(`vault item ${id} not found`)
    const att = await saveImage(photo)
    db.updateVaultItem(id, { photos: [...item.photos, att] })
    notifyVaultChanged()
    return att
  })
  ipcMain.handle('vault:item:removePhoto', (_e, id: string, attachmentId: string) => {
    const item = db.getVaultItem(id)
    if (!item) return
    const gone = item.photos.filter((p) => p.id === attachmentId)
    db.updateVaultItem(id, { photos: item.photos.filter((p) => p.id !== attachmentId) })
    if (gone.length) deleteImages(gone.map((p) => p.filename)).catch(() => {})
    notifyVaultChanged()
  })
  ipcMain.handle('vault:valuation:add', (_e, input: {
    item_id: string; value_mid: number; value_low?: number | null; value_high?: number | null
    source?: string | null; notes?: string | null
  }) => {
    if (!db.getVaultItem(input.item_id)) throw new Error(`vault item ${input.item_id} not found`)
    const v = db.addVaultValuation({ ...input, kind: 'manual', source: input.source || 'manual entry' })
    notifyVaultChanged()
    return v
  })
  ipcMain.handle('vault:valuations', (_e, itemId: string, kind?: string) => db.listVaultValuations(itemId, kind))
  ipcMain.handle('vault:latest', () => db.latestVaultValuations())
  // ---- land search ----
  land.ensureSeeded()
  ipcMain.handle('land:regions', () => land.regionStatus())
  ipcMain.handle('land:job', () => land.jobState())
  ipcMain.handle('land:cancel', () => land.cancelJob())
  ipcMain.handle('land:verifySources', () => land.verifySources())
  ipcMain.handle('land:ingest', (_e, fips: string) => land.ingestParcels(String(fips), win))
  ipcMain.handle('land:markCandidates', (_e, fips: string, filter?: unknown) =>
    land.markCandidates(String(fips), (filter ?? {}) as land.CandidateFilter))
  ipcMain.handle('land:enrich', (_e, fips: string, opts?: unknown) =>
    land.enrichRegion(String(fips), win, (opts ?? {}) as land.EnrichOpts))
  ipcMain.handle('land:assess', (_e, fips: string, year?: number) =>
    land.assessRegion(String(fips), Number(year) || 2024, win))
  ipcMain.handle('land:absentee', (_e, q: unknown) =>
    db.listAbsenteeOwners((q ?? {}) as Parameters<typeof db.listAbsenteeOwners>[0]))
  ipcMain.handle('land:comparable', (_e, lon: number, lat: number) =>
    db.landValuePerAcreNear({ lon: Number(lon), lat: Number(lat) }))
  ipcMain.handle('land:anchors', () => db.listLandAnchors())
  ipcMain.handle('land:saveAnchor', (_e, a: unknown) => {
    db.upsertLandAnchor(a as Parameters<typeof db.upsertLandAnchor>[0])
    land.refitAll()
    return db.listLandAnchors()
  })
  ipcMain.handle('land:deleteAnchor', (_e, id: string) => {
    db.deleteLandAnchor(String(id))
    land.refitAll()
    return db.listLandAnchors()
  })
  ipcMain.handle('land:geocode', (_e, address: string) => land.geocode(String(address)))
  ipcMain.handle('land:fitRegion', (_e, fips: string) => land.fitRegion(String(fips), win))
  ipcMain.handle('land:route', (_e, from: unknown, to: unknown) =>
    land.routeMinutes(from as { lon: number; lat: number }, to as { lon: number; lat: number }))
  ipcMain.handle('land:amenitySpecs', () => land.AMENITIES)
  ipcMain.handle('land:rescore', (_e, fips: string) => land.rescoreRegion(String(fips), land.loadWeights()))
  ipcMain.handle('land:parcels', (_e, q: unknown) => db.landParcelsInView(q as Parameters<typeof db.landParcelsInView>[0]))
  ipcMain.handle('land:parcel', (_e, id: string) => land.parcelDetail(String(id)))
  ipcMain.handle('land:weights', () => land.loadWeights())
  ipcMain.handle('land:setWeights', (_e, w: unknown) => land.saveWeights((w ?? {}) as Partial<land.Weights>))
  ipcMain.handle('land:listings', (_e, status?: string) => db.listLandListings(status || undefined))
  ipcMain.handle('land:saveListing', (_e, l: unknown) => db.upsertLandListing((l ?? {}) as Parameters<typeof db.upsertLandListing>[0]))
  ipcMain.handle('land:deleteListing', (_e, id: string) => { db.deleteLandListing(String(id)); return true })
  ipcMain.handle('land:utilities', (_e, fips?: string) => db.listLandUtilities(fips || undefined))
  ipcMain.handle('land:saveUtility', (_e, u: unknown) => {
    db.upsertLandUtility(u as Parameters<typeof db.upsertLandUtility>[0])
    return db.listLandUtilities()
  })

  ipcMain.handle('vault:spot', (_e, force?: boolean) => vault.spotPrices(Boolean(force)))
  ipcMain.handle('vault:refreshMelt', async () => {
    const r = await vault.refreshMelt()
    notifyVaultChanged()
    return r
  })

  // ----- mtg (release calendar, card prices, watchlist) -----
  const notifyMtgChanged = () => { if (!win.isDestroyed()) win.webContents.send('mtg:changed', {}) }
  ipcMain.handle('mtg:search', (_e, query: string) => mtg.smartSearch(String(query ?? '')))
  ipcMain.handle('mtg:searchSealed', (_e, query: string) => mtg.searchSealed(String(query ?? '')))
  ipcMain.handle('mtg:sets', () => db.listMtgSets())
  ipcMain.handle('mtg:families', () => mtg.setFamilies())
  ipcMain.handle('mtg:familyProducts', (_e, code: string, opts?: { price?: boolean }) =>
    mtg.familyProducts(String(code), { price: !!opts?.price })
  )
  ipcMain.handle('mtg:upcoming', (_e, aheadDays?: number) => mtg.upcomingSets(Number(aheadDays) || undefined))
  ipcMain.handle('mtg:syncSets', async () => {
    const r = await mtg.syncSets()
    const cal = mtg.syncCalendar()
    notifyMtgChanged()
    return { ...r, ...cal }
  })
  // Annotated with Hunt/Market mode, MSRP bands and period lookbacks.
  ipcMain.handle('mtg:watchlist', () => lifecycle.annotateWatchlist())
  ipcMain.handle('mtg:lifecycleSettings', () => lifecycle.settings())
  ipcMain.handle('mtg:setLifecycleSettings', (_e, patch: Partial<lifecycle.LifecycleSettings>) => {
    const out = lifecycle.saveSettings(patch ?? {})
    notifyMtgChanged()
    return out
  })
  ipcMain.handle('mtg:watch:create', (_e, input) => {
    const w = db.createMtgWatch(input)
    notifyMtgChanged()
    return w
  })
  ipcMain.handle('mtg:watch:update', (_e, id: string, patch) => {
    db.updateMtgWatch(id, patch)
    notifyMtgChanged()
    return db.getMtgWatch(id)
  })
  ipcMain.handle('mtg:watch:delete', (_e, id: string) => {
    db.deleteMtgWatch(id)
    notifyMtgChanged()
  })
  ipcMain.handle('mtg:prices', (_e, extId: string, variant: string, limitDays?: number) =>
    db.listMtgPrices(extId, variant, Number(limitDays) || undefined))
  ipcMain.handle('mtg:refreshPrices', async () => {
    const r = await mtg.refreshPrices(win)
    notifyMtgChanged()
    notifyVaultChanged()
    return r
  })
  // Promote a watchlist row into an owned Vault item once it's actually bought.
  ipcMain.handle('mtg:watch:acquire', (_e, id: string, opts?: { purchase_price?: number | null; purchase_date?: string | null; quantity?: number }) => {
    const w = db.getMtgWatch(id)
    if (!w) throw new Error(`watchlist entry ${id} not found`)
    const item = db.createVaultItem({
      category: w.kind === 'sealed' ? 'mtg_sealed' : 'mtg_card',
      name: w.name,
      maker: w.set_code ? `${w.set_code.toUpperCase()}${w.collector_number ? ` #${w.collector_number}` : ''}` : null,
      quantity: opts?.quantity ?? 1,
      purchase_price: opts?.purchase_price ?? null,
      purchase_date: opts?.purchase_date ?? null,
      notes: w.notes,
      ext_source: w.ext_source,
      ext_id: w.ext_id,
      variant: w.variant
    })
    // Carry the price history across: mtg_prices survives the watch row being
    // deleted, but nothing would draw it until the item had accrued its own
    // valuations. Replay them so the Vault chart opens fully populated.
    const carried = db.backfillVaultValuations(item.id)
    db.deleteMtgWatch(id)
    notifyMtgChanged()
    notifyVaultChanged()
    return { ...item, carriedPoints: carried }
  })
  // Stacked for display; rebuildHistory below still walks the per-row list.
  ipcMain.handle('mtg:owned', () => decks.attachDeckUsage(db.attachPeriodPrices(db.listMtgOwnedStacked())))
  // Fire-and-forget from the renderer: the Owned tab calls this on mount so the
  // colour filter fills itself in, and a failure (offline, Scryfall down) must
  // not stop the list rendering with the metadata it already has.
  ipcMain.handle('mtg:commanders', () =>
    db.listOwnedCommanders().map((c) => ({ ...c, edhrec_url: edhrec.commanderUrl(c.edhrec_slug, c.name) }))
  )
  ipcMain.handle('mtg:commanderStats', () => db.countCommanderStats())
  ipcMain.handle('mtg:syncCommanders', async () => {
    const r = await edhrec.syncCommanderStats()
    notifyMtgChanged()
    return r
  })
  ipcMain.handle('mtg:syncCardMeta', async () => {
    const r = await mtg.syncOwnedCardMeta()
    if (r.fetched) notifyMtgChanged()
    return r
  })
  // cEDH play rates for owned cards; weekly per card unless forced.
  ipcMain.handle('mtg:syncCedh', async (_e, force?: boolean) => {
    const r = await cedh.syncOwned(!!force)
    if (r.asked) notifyMtgChanged()
    return r
  })
  // ---- play in ATLIS (Forge engine, ATLIS table) ----
  const gameEvent = (e: forgeGame.GameEvent): void => { if (!win.isDestroyed()) win.webContents.send('game:event', e) }
  ipcMain.handle('game:readiness', () => forgeGame.readiness(app.getAppPath()))
  ipcMain.handle('game:decks', () => forgeGame.listDecks())
  ipcMain.handle('game:start', (_e, opts: forgeGame.StartOptions) =>
    forgeGame.start(app.getAppPath(), { deck: String(opts?.deck ?? ''), opponents: Array.isArray(opts?.opponents) ? opts.opponents.map(String).slice(0, 3) : [] }, gameEvent))
  ipcMain.handle('game:send', (_e, cmd: Record<string, unknown>) => { if (cmd && typeof cmd.cmd === 'string') forgeGame.send(cmd) })
  ipcMain.handle('game:stop', () => forgeGame.stop())
  ipcMain.handle('sounds:library', () => gameSounds.library())
  ipcMain.handle('sounds:save', (_e, settings: unknown) => gameSounds.save(settings))
  ipcMain.handle('sounds:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add sound effects',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'] }]
    })
    if (r.canceled) return []
    return gameSounds.importFiles(r.filePaths)
  })
  ipcMain.handle('sounds:remove', (_e, name: string) => gameSounds.removeCustom(String(name)))
  ipcMain.handle('table:look', () => gameSounds.lookGet())
  ipcMain.handle('table:saveLook', (_e, look: unknown) => gameSounds.lookSave(look))
  ipcMain.handle('table:importMat', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add a playmat image',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    })
    if (r.canceled) return []
    return gameSounds.importMats(r.filePaths)
  })
  ipcMain.handle('table:removeMat', (_e, name: string) => gameSounds.removeMat(String(name)))
  win.on('closed', () => forgeGame.stop())

  // ---- play (Forge) ----
  ipcMain.handle('forge:status', () => forge.status())
  ipcMain.handle('forge:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Your Forge folder (the one with forge.exe in it)',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, message: null }
    return forge.setInstallDir(r.filePaths[0])
      ? { ok: true, message: null }
      : { ok: false, message: 'That folder doesn’t look like Forge — pick the one containing forge.exe and a res folder.' }
  })
  ipcMain.handle('forge:export', () => forge.exportDecks())
  ipcMain.handle('forge:launch', () => forge.launch())
  ipcMain.handle('forge:openUrl', (_e, url: string) => {
    // Only the two download pages the setup steps link to.
    if (/^https:\/\/(github\.com\/Card-Forge\/forge\/releases|adoptium\.net\/)/.test(String(url))) void electronShell.openExternal(String(url))
  })

  // ---- decks ----
  ipcMain.handle('mtg:decks', () => decks.listDecks())
  ipcMain.handle('mtg:deck', (_e, id: string) => decks.getDeck(String(id)))
  ipcMain.handle('mtg:deckCreate', (_e, input: { name: string; commanders?: Array<{ name: string; ext_id?: string | null }> }) =>
    decks.createDeck({ name: String(input?.name ?? ''), commanders: Array.isArray(input?.commanders) ? input.commanders : [] }))
  ipcMain.handle('mtg:deckImport', (_e, name: string, text: string) => decks.importDeck(String(name ?? ''), String(text ?? '')))
  ipcMain.handle('mtg:deckSetCard', (_e, id: string, card: { name: string; ext_id?: string | null; quantity: number; board: string }) =>
    decks.setCard(String(id), {
      name: String(card.name),
      ext_id: card.ext_id ?? null,
      quantity: Number(card.quantity) || 0,
      board: card.board === 'commander' ? 'commander' : 'main'
    }))
  ipcMain.handle('mtg:deckMoveCard', (_e, id: string, name: string, to: string) =>
    decks.moveCard(String(id), String(name), to === 'commander' ? 'commander' : 'main'))
  ipcMain.handle('mtg:deckRename', (_e, id: string, name: string) => decks.renameDeck(String(id), String(name ?? '')))
  ipcMain.handle('mtg:deckDelete', (_e, id: string) => decks.deleteDeck(String(id)))
  ipcMain.handle('mtg:deckCandidates', () => decks.deckCandidates())
  ipcMain.handle('mtg:deckFromSealed', (_e, vaultId: string) => decks.deckFromSealed(String(vaultId)))
  ipcMain.handle('mtg:searchPrecons', (_e, query: string) => decks.searchPrecons(String(query ?? '')))
  ipcMain.handle('mtg:deckFromPrecon', (_e, fileName: string) => decks.deckFromPrecon(String(fileName)))
  ipcMain.handle('mtg:deckFromRipped', (_e, product: string) => decks.deckFromRipped(String(product)))
  ipcMain.handle('mtg:deckRecs', (_e, id: string) => decks.deckRecs(String(id)))
  ipcMain.handle('mtg:shoppingList', () => decks.shoppingList())
  ipcMain.handle('mtg:cedhMatches', () => decks.cedhMatches())
  ipcMain.handle('mtg:cedhList', (_e, entryId: string) => decks.cedhList(String(entryId)))
  ipcMain.handle('mtg:cedhSaveDeck', (_e, entryId: string) => decks.saveCedhAsDeck(String(entryId)))
  ipcMain.handle('mtg:exploreCommanders', (_e, limit?: number) => decks.exploreCommanders(Number(limit) || 400))
  ipcMain.handle('mtg:exploreCommander', (_e, f: { commanders: string[]; bracket?: number | null; theme?: string | null }) =>
    decks.exploreCommander({ commanders: (f?.commanders ?? []).map(String), bracket: f?.bracket ?? null, theme: f?.theme ?? null }))
  ipcMain.handle('mtg:exploreDeck', (_e, ref: decks.ExploreRef) => decks.exploreDeck(ref))
  ipcMain.handle('mtg:exploreSaveDeck', (_e, ref: decks.ExploreRef) => decks.saveExploreDeck(ref))
  ipcMain.handle('mtg:syncCedhLists', (_e, opts?: { commanders?: number; perCommander?: number }) =>
    decks.syncCedhLists(opts ?? {}))
  ipcMain.handle('mtg:sealedFollowed', () => mtg.listFollowedSealedSets())
  ipcMain.handle('mtg:sealedFollow', (_e, code: string, follow?: boolean) => {
    const list = mtg.followSealedSet(String(code), follow !== false)
    notifyMtgChanged()
    return list
  })
  ipcMain.handle('mtg:sealedPrices', (_e, setCode: string, days?: number) => {
    const d = Number(days) || 60
    const since = new Date(Date.now() - d * 86_400_000)
    const p = (n: number): string => String(n).padStart(2, '0')
    return db.sealedPriceSnapshot(String(setCode),
      `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`)
  })
  ipcMain.handle('mtg:refreshSealed', async () => {
    const r = await mtg.refreshFollowedSealed()
    notifyMtgChanged()
    return r
  })
  ipcMain.handle('mtg:secretLair', (_e, days?: number) => mtg.recentSecretLair(Number(days) || undefined))
  // Announced-but-unreleased drops. Read is local; sync hits the upstream feed.
  ipcMain.handle('mtg:secretLairUpcoming', () => secretlair.upcomingByDrop())
  ipcMain.handle('mtg:syncSecretLair', async () => {
    const r = await secretlair.syncUpcoming()
    notifyMtgChanged()
    return r
  })
  ipcMain.handle('mtg:packEv', (_e, query: string, boosterType?: string, packPrice?: number) =>
    mtg.packEv(String(query ?? ''), boosterType === 'play' ? 'play' : 'collector', 20_000,
      typeof packPrice === 'number' && isFinite(packPrice) ? packPrice : null))
  ipcMain.handle('mtg:valueSet', (_e, query: string, force?: boolean) => mtg.valueSet(String(query ?? ''), Boolean(force)))
  ipcMain.handle('mtg:valueCardList', (_e, text: string, label?: string) =>
    mtg.valueCardList(String(text ?? ''), typeof label === 'string' ? label : undefined))
  ipcMain.handle('mtg:cardInsights', (_e, names: unknown, reprintNames: unknown, excludeSets: unknown, excludeIds: unknown) => {
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return mtg.cardInsights(strs(names), strs(reprintNames), strs(excludeSets), strs(excludeIds))
  })
  ipcMain.handle('mtg:valueFromUrl', (_e, url: string) => mtg.valueFromUrl(String(url ?? '')))
  // ---- retail availability ----
  ipcMain.handle('mtg:listings', (_e, watchId?: string) =>
    db.listMtgListings(watchId ? { watchId } : {}))
  ipcMain.handle('mtg:discover', async (_e, watchId: string) => {
    const r = await retail.discoverForWatch(String(watchId))
    notifyMtgChanged()
    return r
  })
  ipcMain.handle('mtg:listing:add', async (_e, watchId: string, url: string) => {
    const l = await retail.addManualListing(String(watchId), String(url))
    notifyMtgChanged()
    return l
  })
  ipcMain.handle('mtg:listing:remove', (_e, id: string) => {
    db.deleteMtgListing(String(id))
    notifyMtgChanged()
  })
  ipcMain.handle('mtg:preorderBoard', (_e, aheadDays?: number) =>
    mtg.preorderBoard(Number(aheadDays) || undefined))
  ipcMain.handle('mtg:scanPreorders', async (_e, aheadDays?: number) => {
    const r = await mtg.scanPreorders(Number(aheadDays) || undefined, (msg) => {
      if (!win.isDestroyed()) win.webContents.send('mtg:preorderProgress', { message: msg })
    })
    notifyMtgChanged()
    return r
  })
  // Master mute for MTG desktop notifications (price targets + stock changes).
  ipcMain.handle('mtg:alertsEnabled', () => mtg.alertsEnabled())
  ipcMain.handle('mtg:setAlertsEnabled', (_e, on: boolean) => mtg.setAlertsEnabled(!!on))
  // What's inside a sealed product, and what those cards are worth vs its price.
  ipcMain.handle('mtg:sealedContents', (_e, uuid: string, force?: boolean) =>
    mtg.sealedContents(String(uuid), !!force))
  // Owned / watched rows only know their TCGplayer id.
  ipcMain.handle('mtg:productContents', (_e, productId: string, setHint?: string | null) =>
    mtg.productContents(String(productId), setHint ?? null))
  // Open an owned sealed copy: its cards join Owned, the sealed count drops by one.
  ipcMain.handle('mtg:ripSealed', async (_e, vaultId: string) => {
    const r = await mtg.ripSealed(String(vaultId))
    notifyMtgChanged()
    notifyVaultChanged()
    return r
  })
  // Standing EV board for sealed product.
  ipcMain.handle('mtg:evBoard', () => ev.board())
  ipcMain.handle('mtg:evScan', async (_e, opts?: ev.EvScanOptions) => {
    const r = await ev.scan(opts ?? {}, (msg) => {
      if (!win.isDestroyed()) win.webContents.send('mtg:evProgress', { message: msg })
    })
    notifyMtgChanged()
    return r
  })
  ipcMain.handle('mtg:evReprice', async () => {
    const r = await ev.repriceAll()
    notifyMtgChanged()
    return r
  })
  ipcMain.handle('mtg:evForget', (_e, uuid: string) => {
    db.deleteMtgEv(String(uuid))
    notifyMtgChanged()
  })
  // Watchlist products a big-box retailer currently has well under market.
  ipcMain.handle('mtg:deals', () => retail.deals())
  ipcMain.handle('mtg:dealThreshold', () => retail.dealThreshold())
  ipcMain.handle('mtg:setDealThreshold', (_e, v: number) => retail.setDealThreshold(Number(v)))
  ipcMain.handle('mtg:refreshStock', async () => {
    const r = await retail.refreshListings()
    notifyMtgChanged()
    return r
  })
  // Repair pass for items acquired before history was carried across.
  // Long-running (streams ~900MB of MTGJSON); pushes progress so the UI can
  // show something other than a frozen button.
  ipcMain.handle('mtg:backfill', async () => {
    const r = await mtg.backfillHistory((p) => {
      if (!win.isDestroyed()) win.webContents.send('mtg:backfillProgress', p)
    })
    notifyMtgChanged()
    notifyVaultChanged()
    return r
  })
  ipcMain.handle('mtg:rebuildHistory', () => {
    let items = 0
    let points = 0
    for (const o of db.listMtgOwned()) {
      const n = db.backfillVaultValuations(o.id)
      if (n > 0) { items++; points += n }
    }
    notifyMtgChanged()
    notifyVaultChanged()
    return { items, points }
  })

  // ----- drops (limited-run availability) -----
  const notifyDropsChanged = () => { if (!win.isDestroyed()) win.webContents.send('drops:changed', {}) }
  ipcMain.handle('drops:watches', () => db.listDropWatches())
  ipcMain.handle('drops:products', (_e, watchId?: string, includeGone?: boolean) =>
    db.listDropProducts(watchId ? String(watchId) : undefined, !!includeGone))
  ipcMain.handle('drops:events', (_e, opts?: { watchId?: string; limit?: number }) => db.listDropEvents(opts))
  ipcMain.handle('drops:unseen', () => db.unseenDropEventCount())
  ipcMain.handle('drops:markSeen', (_e, watchId?: string) => {
    db.markDropEventsSeen(watchId ? String(watchId) : undefined)
    notifyDropsChanged()
  })
  ipcMain.handle('drops:add', async (_e, input: { label?: string; url: string; title_match?: string | null; priority?: string }) => {
    const w = await drops.addWatch(input)
    notifyDropsChanged()
    return w
  })
  ipcMain.handle('drops:update', (_e, id: string, patch: unknown) => {
    db.updateDropWatch(String(id), patch as Record<string, never>)
    notifyDropsChanged()
  })
  ipcMain.handle('drops:remove', (_e, id: string) => {
    db.deleteDropWatch(String(id))
    notifyDropsChanged()
  })
  // Manual poll — one watch, or every enabled watch when no id is given.
  ipcMain.handle('drops:poll', async (_e, watchId?: string) => {
    const r = watchId
      ? { watches: 1, changed: 0, transitions: await drops.pollWatch(String(watchId)), errors: [] as string[] }
      : await drops.pollAll()
    // A manual check consumes the transition — it writes the new product state,
    // so the next scheduled sweep sees nothing changed. Without dispatching
    // here, hitting "check now" at the wrong moment finds a drop and silently
    // swallows the alert for it. The cooldown prevents a double ping.
    if (r.transitions.length) await alerts.dispatch(r.transitions.map(drops.toAlert))
    notifyDropsChanged()
    return r
  })
  ipcMain.handle('drops:probe', (_e, url: string) => drops.probeShopify(String(url)))
  ipcMain.handle('drops:alertsEnabled', () => drops.alertsEnabled())
  ipcMain.handle('drops:setAlertsEnabled', (_e, on: boolean) => drops.setAlertsEnabled(!!on))

  // ----- alert delivery (sinks) -----
  ipcMain.handle('alerts:config', () => ({
    enabled: alerts.alertsEnabled(),
    sinks: alerts.sinkStatus(),
    discord: discordAlert.readConfig(),
    kinds: alerts.ALERT_KINDS,
    defaultKinds: alerts.DEFAULT_KINDS,
    defaultCooldownMs: alerts.DEFAULT_COOLDOWN_MS
  }))
  ipcMain.handle('alerts:setDiscord', (_e, patch: { webhook?: string; mention?: string }) =>
    discordAlert.writeConfig({
      webhook: patch?.webhook === undefined ? undefined : String(patch.webhook),
      mention: patch?.mention === undefined ? undefined : String(patch.mention)
    })
  )
  // Deliberately bypasses policy and cooldown: a test that could be silently
  // swallowed proves nothing.
  ipcMain.handle('alerts:test', () =>
    alerts.sendDirect({
      kind: 'restock',
      watchId: 'test',
      watchLabel: 'ATLIS test',
      extId: 'test:' + Date.now(),
      title: 'If you can read this, alerts are working.',
      detail: 'Sent from Settings — no watch produced this.',
      url: null,
      image: null,
      price: null
    })
  )

  // ----- tcg (card watches for games other than Magic; Magic keeps mtg:*) -----
  const notifyTcgChanged = () => { if (!win.isDestroyed()) win.webContents.send('tcg:changed', {}) }
  ipcMain.handle('tcg:games', () => tcg.TCG_GAMES)
  ipcMain.handle('tcg:counts', () => tcg.counts())
  ipcMain.handle('tcg:search', (_e, input: Parameters<typeof tcg.search>[0]) => tcg.search(input))
  ipcMain.handle('tcg:sets', (_e, game: string) => tcg.sets(String(game)))
  ipcMain.handle('tcg:set', (_e, game: string, set: string) => tcg.setProducts(String(game), String(set)))
  ipcMain.handle('tcg:watches', (_e, game?: string) => db.listTcgWatches(game ? String(game) : undefined))
  ipcMain.handle('tcg:add', async (_e, input: Parameters<typeof tcg.addWatch>[0]) => {
    const w = await tcg.addWatch(input)
    notifyTcgChanged()
    return w
  })
  // Owned sealed lands in the Vault and the Magic Owned list, so both refresh.
  ipcMain.handle('tcg:ownSealed', async (_e, input: Parameters<typeof tcg.ownSealed>[0]) => {
    const item = await tcg.ownSealed(input)
    notifyMtgChanged()
    notifyVaultChanged()
    return item
  })
  // Only the fields a person edits; bookkeeping columns are the module's.
  ipcMain.handle('tcg:update', (_e, id: string, patch: { target_price?: number | null; notify?: number; notes?: string | null }) => {
    const safe: Partial<db.TcgWatch> = {}
    if (patch && 'target_price' in patch) safe.target_price = patch.target_price ?? null
    if (patch && 'notify' in patch) safe.notify = patch.notify ? 1 : 0
    if (patch && 'notes' in patch) safe.notes = patch.notes ?? null
    db.updateTcgWatch(String(id), safe)
    notifyTcgChanged()
  })
  ipcMain.handle('tcg:remove', (_e, id: string) => {
    db.deleteTcgWatch(String(id))
    notifyTcgChanged()
  })
  ipcMain.handle('tcg:history', (_e, id: string) => tcg.history(String(id)))
  ipcMain.handle('tcg:quote', (_e, productId: string) => tcg.quote(String(productId)))
  ipcMain.handle('tcg:check', async (_e, target?: { id?: string; game?: string }) => {
    const r = await tcg.check(target ?? {})
    notifyTcgChanged()
    return r
  })

  // ----- signals (demand intent) + coverage -----
  const notifySignalsChanged = () => { if (!win.isDestroyed()) win.webContents.send('signals:changed', {}) }
  ipcMain.handle('signals:terms', () => db.listSignalTerms())
  ipcMain.handle('signals:read', (_e, termId: string, windowDays?: number) =>
    signals.readTerm(String(termId), Number(windowDays) || undefined))
  ipcMain.handle('signals:readAll', (_e, windowDays?: number) =>
    db.listSignalTerms().map((t) => signals.readTerm(t.id, Number(windowDays) || undefined)).filter(Boolean))
  ipcMain.handle('signals:track', (_e, term: string) => {
    const t = signals.trackTerm(String(term))
    notifySignalsChanged()
    return t
  })
  ipcMain.handle('signals:untrack', (_e, id: string) => {
    db.deleteSignalTerm(String(id))
    notifySignalsChanged()
  })
  ipcMain.handle('signals:sample', async (_e, termId: string) => {
    const r = await signals.sampleTerm(String(termId))
    notifySignalsChanged()
    return r
  })
  ipcMain.handle('signals:sweep', async () => {
    const r = await signals.sweep()
    notifySignalsChanged()
    return r
  })
  ipcMain.handle('signals:trending', (_e, geo?: string) => signals.trendingSearches(String(geo || 'US')))

  ipcMain.handle('drops:candidateCounts', () => db.dropCandidateCounts())
  ipcMain.handle('drops:topCandidates', (_e, limit?: number) => db.listTopCandidates(Number(limit) || undefined))
  ipcMain.handle('drops:discover', async (_e, opts?: { page?: number; limit?: number }) => {
    const r = await discovery.discoverShopifyStores(opts ?? {})
    notifyDropsChanged()
    return r
  })
  ipcMain.handle('drops:probeCandidates', async (_e, limit?: number) => {
    const r = await discovery.probeCandidates(Number(limit) || undefined)
    notifyDropsChanged()
    return r
  })
  ipcMain.handle('drops:promote', async (_e, count?: number, minScore?: number) => {
    const r = await discovery.promoteCandidates(Number(count) || undefined, Number(minScore) || undefined)
    notifyDropsChanged()
    return r
  })
  ipcMain.handle('drops:score', () => {
    const r = discovery.scoreWatches()
    const tiers = discovery.retier()
    notifyDropsChanged()
    return { ...r, ...tiers }
  })

  // ----- discord (public community telemetry) -----
  const notifyDiscordChanged = () => { if (!win.isDestroyed()) win.webContents.send('discord:changed', {}) }
  ipcMain.handle('discord:watches', () => db.listDiscordWatches())
  ipcMain.handle('discord:readAll', () => discord.readAll())
  ipcMain.handle('discord:read', (_e, id: string) => discord.reading(String(id)))
  ipcMain.handle('discord:track', async (_e, input: string, watchId?: string) => {
    const w = await discord.trackInvite(String(input), watchId ? String(watchId) : null)
    notifyDiscordChanged()
    return w
  })
  ipcMain.handle('discord:untrack', (_e, id: string) => {
    db.deleteDiscordWatch(String(id))
    notifyDiscordChanged()
  })
  ipcMain.handle('discord:sweep', async () => {
    const r = await discord.sweep(win)
    notifyDiscordChanged()
    return r
  })
  // Find a shop's server from its own pages and start watching it.
  ipcMain.handle('discord:fromStore', async (_e, watchId: string) => {
    const r = await discord.discoverFromStore(String(watchId))
    notifyDiscordChanged()
    return r
  })
  ipcMain.handle('discord:alertsEnabled', () => discord.alertsEnabled())
  ipcMain.handle('discord:setAlertsEnabled', (_e, on: boolean) => discord.setAlertsEnabled(!!on))

  // ----- torrents -----
  // download dir is a plain setting; falls back to ~/Downloads/ATLIS Torrents
  const torrentSaveDir = () => db.getSetting('torrent_save_dir') || join(app.getPath('downloads'), 'ATLIS Torrents')
  const notifyTorrentsChanged = (list: unknown) => { if (!win.isDestroyed()) win.webContents.send('torrents:changed', list) }
  const torrents = new TorrentManager(
    join(app.getPath('userData'), 'torrents'),
    { list: db.listTorrents, get: db.getTorrent, insert: db.insertTorrent, update: db.updateTorrent, remove: db.deleteTorrent },
    notifyTorrentsChanged
  )
  void torrents.resumeAll() // re-attach anything that was mid-download at last quit
  ipcMain.handle('torrents:list', () => torrents.list())
  ipcMain.handle('torrents:add', (_e, input: AddTorrentInput) => torrents.add(input, torrentSaveDir()))
  ipcMain.handle('torrents:pause', (_e, id: string) => torrents.pause(id))
  ipcMain.handle('torrents:resume', (_e, id: string) => torrents.resume(id))
  ipcMain.handle('torrents:remove', (_e, id: string, deleteFiles: boolean) => torrents.remove(id, Boolean(deleteFiles)))
  ipcMain.handle('torrents:openFolder', (_e, id: string) => {
    const path = torrents.contentPath(id)
    if (path) electronShell.showItemInFolder(path)
  })
  ipcMain.handle('torrents:getDir', () => torrentSaveDir())
  ipcMain.handle('torrents:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Torrent download folder',
      defaultPath: torrentSaveDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (!r.canceled && r.filePaths[0]) db.setSetting('torrent_save_dir', r.filePaths[0])
    return torrentSaveDir()
  })

  // ----- documents -----
  ipcMain.handle('docs:list', () => db.listDocs())
  ipcMain.handle('docs:get', (_e, id: string) => db.getDoc(id))
  ipcMain.handle('docs:save', (_e, doc) => db.saveDoc(doc))
  ipcMain.handle('docs:delete', (_e, id: string) => db.deleteDoc(id))
  ipcMain.handle('docs:toMarkdown', (_e, html: string) => htmlToMd(html))
  ipcMain.handle('docs:toHtml', (_e, md: string) => mdToHtml(md))

  return { discordBot, browser, runner, shell, mcp, apps, desktop, torrents }
}
