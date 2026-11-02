import { useEffect } from 'react'
import { useAtlis } from './state/store'
import TitleBar from './components/TitleBar'
import NavRail from './components/NavRail'
import SessionsSidebar from './components/SessionsSidebar'
import ChatView from './components/ChatView'
import BrowserPanel from './components/BrowserPanel'
import BrowserView from './components/BrowserView'
import MediaDock from './components/MediaDock'
import PlannerView from './components/PlannerView'
import DocsView from './components/DocsView'
import FinanceView from './components/FinanceView'
import VaultView from './components/VaultView'
import LandView from './components/LandView'
import MtgView from './components/MtgView'
import DropsView from './components/DropsView'
import FeedView from './components/FeedView'
import ArenaView from './components/ArenaView'
import AgentZooView from './components/AgentZooView'
import TorrentsView from './components/TorrentsView'
import SettingsView from './components/SettingsView'
import HubView from './components/HubView'
import LifeBackground from './components/LifeBackground'

export default function App() {
  const { view, browserOpen, refreshSessions, refreshProjects, loadBookmarks, loadDisabledApps, handleEvent, syncBrowser } = useAtlis()

  useEffect(() => {
    refreshSessions()
    refreshProjects()
    loadBookmarks()
    loadDisabledApps()
    // seed the toolbar/tab rail before the first push arrives
    window.atlis.browser.state().then(syncBrowser)
    const offs = [
      window.atlis.chat.onEvent(handleEvent),
      window.atlis.browser.onState(syncBrowser)
    ]
    return () => offs.forEach((off) => off())
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-ink-900 text-mist-100">
      <LifeBackground />
      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <NavRail />
          {view === 'chat' && <SessionsSidebar />}
          <main className="flex min-w-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col">
              {view === 'hub' && <HubView />}
              {view === 'chat' && <ChatView />}
              {view === 'browser' && <BrowserView />}
              {view === 'planner' && <PlannerView />}
              {view === 'feed' && <FeedView />}
              {view === 'arena' && <ArenaView />}
              {view === 'finance' && <FinanceView />}
              {view === 'vault' && <VaultView />}
              {view === 'land' && <LandView />}
              {view === 'mtg' && <MtgView />}
              {view === 'drops' && <DropsView />}
              {view === 'docs' && <DocsView />}
              {view === 'agentZoo' && <AgentZooView />}
              {view === 'torrents' && <TorrentsView />}
              {view === 'settings' && <SettingsView />}
            </div>
            {/* side panel yields to the full browser view — both would fight over the one native view */}
            {browserOpen && view !== 'browser' && <BrowserPanel />}
          </main>
        </div>
        <MediaDock />
      </div>
    </div>
  )
}
