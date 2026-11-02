import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, CheckCircle2, Circle, Clock, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CalendarEvent, ReminderItem, TodoItem } from '../types'

const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const dayEnd = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const fmtDateTime = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const toLocalInput = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (s: string) => new Date(s).getTime()

export default function PlannerView() {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [eventTitle, setEventTitle] = useState('')
  const [eventStart, setEventStart] = useState(toLocalInput(Date.now() + 60 * 60 * 1000))
  const [eventDuration, setEventDuration] = useState('60')
  const [todoTitle, setTodoTitle] = useState('')
  const [todoPriority, setTodoPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [reminderTitle, setReminderTitle] = useState('')
  const [reminderAt, setReminderAt] = useState(toLocalInput(Date.now() + 60 * 60 * 1000))
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    try {
      const now = Date.now()
      const in30 = now + 30 * 24 * 60 * 60 * 1000
      const [evs, tds, rms] = await Promise.all([
        window.atlis.planner.events.list(dayStart(), in30),
        window.atlis.planner.todos.list({ status: 'active' }),
        window.atlis.planner.reminders.list(now - 24 * 60 * 60 * 1000, in30, 'pending')
      ])
      setEvents(evs)
      setTodos(tds)
      setReminders(rms)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load()
    const off = window.atlis.planner.onChanged(load)
    return off
  }, [])

  const todayEvents = useMemo(() => events.filter((e) => e.start_at >= dayStart() && e.start_at <= dayEnd()), [events])
  const upcomingEvents = useMemo(() => events.filter((e) => e.start_at > dayEnd()).slice(0, 12), [events])
  const overdueTodos = useMemo(() => todos.filter((t) => t.due_at && t.due_at < Date.now()), [todos])

  const addEvent = async () => {
    if (!eventTitle.trim()) return
    const start = fromLocalInput(eventStart)
    const duration = Math.max(1, Number(eventDuration) || 60)
    await window.atlis.planner.events.create({ title: eventTitle.trim(), start_at: start, end_at: start + duration * 60 * 1000 })
    setEventTitle('')
    await load()
  }

  const addTodo = async () => {
    if (!todoTitle.trim()) return
    await window.atlis.planner.todos.create({ title: todoTitle.trim(), priority: todoPriority })
    setTodoTitle('')
    await load()
  }

  const addReminder = async () => {
    if (!reminderTitle.trim()) return
    await window.atlis.planner.reminders.create({ title: reminderTitle.trim(), remind_at: fromLocalInput(reminderAt) })
    setReminderTitle('')
    await load()
  }

  const completeTodo = async (id: string) => {
    await window.atlis.planner.todos.complete(id)
    await load()
  }

  const deleteTodo = async (id: string) => {
    await window.atlis.planner.todos.remove(id)
    await load()
  }

  const deleteEvent = async (id: string) => {
    await window.atlis.planner.events.remove(id)
    await load()
  }

  const deleteReminder = async (id: string) => {
    await window.atlis.planner.reminders.remove(id)
    await load()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink-900">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-ink-600 px-5">
        <div>
          <h1 className="text-sm font-semibold text-mist-100">Planner</h1>
          <p className="text-xs text-mist-500">Local calendar, reminders, and calendar-agnostic to-dos for ATLIS.</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-2 rounded-md border border-ink-600 px-3 py-1.5 text-xs text-mist-300 hover:bg-ink-800">
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-5 xl:grid-cols-[1.1fr_1fr]">
        <section className="space-y-4">
          <div className="rounded-xl border border-ink-600 bg-ink-850 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-mist-100"><CalendarDays size={17} className="text-volt-400" /> Add calendar event</div>
            <div className="grid gap-2 md:grid-cols-[1fr_220px_110px_auto]">
              <input value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addEvent()} placeholder="Work, dentist, dinner..." className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-volt-500" />
              <input type="datetime-local" value={eventStart} onChange={(e) => setEventStart(e.target.value)} className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-volt-500" />
              <input value={eventDuration} onChange={(e) => setEventDuration(e.target.value)} title="Duration in minutes" className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-volt-500" />
              <button onClick={addEvent} className="inline-flex items-center justify-center gap-2 rounded-md bg-volt-500 px-3 py-2 text-sm font-medium text-ink-950 hover:bg-volt-400"><Plus size={15} /> Add</button>
            </div>
          </div>

          <div className="rounded-xl border border-ink-600 bg-ink-850 p-4">
            <h2 className="mb-3 text-sm font-semibold text-mist-100">Today</h2>
            {todayEvents.length === 0 ? <p className="text-sm text-mist-500">No events today.</p> : (
              <div className="space-y-2">
                {todayEvents.map((e) => <EventRow key={e.id} event={e} onDelete={() => deleteEvent(e.id)} />)}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-ink-600 bg-ink-850 p-4">
            <h2 className="mb-3 text-sm font-semibold text-mist-100">Upcoming events</h2>
            {upcomingEvents.length === 0 ? <p className="text-sm text-mist-500">Nothing scheduled in the next 30 days.</p> : (
              <div className="space-y-2">
                {upcomingEvents.map((e) => <EventRow key={e.id} event={e} onDelete={() => deleteEvent(e.id)} showDate />)}
              </div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <div className="rounded-xl border border-ink-600 bg-ink-850 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-mist-100"><CheckCircle2 size={17} className="text-volt-400" /> Add to-do</div>
            <div className="grid gap-2 md:grid-cols-[1fr_130px_auto]">
              <input value={todoTitle} onChange={(e) => setTodoTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTodo()} placeholder="Thing to accomplish..." className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-volt-500" />
              <select value={todoPriority} onChange={(e) => setTodoPriority(e.target.value as 'low' | 'normal' | 'high')} className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-volt-500">
                <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
              </select>
              <button onClick={addTodo} className="inline-flex items-center justify-center gap-2 rounded-md bg-volt-500 px-3 py-2 text-sm font-medium text-ink-950 hover:bg-volt-400"><Plus size={15} /> Add</button>
            </div>
          </div>

          <div className="rounded-xl border border-ink-600 bg-ink-850 p-4">
            <h2 className="mb-3 text-sm font-semibold text-mist-100">To-dos</h2>
            {overdueTodos.length > 0 && <p className="mb-2 text-xs text-red-300">{overdueTodos.length} overdue</p>}
            {todos.length === 0 ? <p className="text-sm text-mist-500">No active to-dos.</p> : (
              <div className="space-y-2">
                {todos.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/70 px-3 py-2">
                    <button onClick={() => completeTodo(t.id)} className="text-mist-500 hover:text-volt-400"><Circle size={18} /></button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-mist-100">{t.title}</div>
                      <div className="text-xs text-mist-500">{t.priority} priority{t.due_at ? ` · due ${fmtDateTime(t.due_at)}` : ''}</div>
                    </div>
                    <button onClick={() => deleteTodo(t.id)} className="text-mist-600 hover:text-red-300"><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-ink-600 bg-ink-850 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-mist-100"><Clock size={17} className="text-volt-400" /> Add reminder</div>
            <div className="grid gap-2 md:grid-cols-[1fr_220px_auto]">
              <input value={reminderTitle} onChange={(e) => setReminderTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addReminder()} placeholder="Remind me to..." className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-volt-500" />
              <input type="datetime-local" value={reminderAt} onChange={(e) => setReminderAt(e.target.value)} className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-volt-500" />
              <button onClick={addReminder} className="inline-flex items-center justify-center gap-2 rounded-md bg-volt-500 px-3 py-2 text-sm font-medium text-ink-950 hover:bg-volt-400"><Plus size={15} /> Add</button>
            </div>
            <div className="mt-4 space-y-2">
              {reminders.length === 0 ? <p className="text-sm text-mist-500">No upcoming reminders.</p> : reminders.slice(0, 10).map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/70 px-3 py-2">
                  <Clock size={15} className="text-mist-500" />
                  <div className="min-w-0 flex-1"><div className="truncate text-sm text-mist-100">{r.title}</div><div className="text-xs text-mist-500">{fmtDateTime(r.remind_at)}</div></div>
                  <button onClick={() => deleteReminder(r.id)} className="text-mist-600 hover:text-red-300"><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function EventRow({ event, onDelete, showDate }: { event: CalendarEvent; onDelete: () => void; showDate?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/70 px-3 py-2">
      <div className="flex h-9 w-12 shrink-0 items-center justify-center rounded-md bg-volt-500/10 text-xs font-medium text-volt-300">{fmtTime(event.start_at)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-mist-100">{event.title}</div>
        <div className="text-xs text-mist-500">{showDate ? fmtDateTime(event.start_at) : `${fmtTime(event.start_at)}${event.end_at ? ` – ${fmtTime(event.end_at)}` : ''}`}{event.location ? ` · ${event.location}` : ''}</div>
      </div>
      <button onClick={onDelete} className="text-mist-600 hover:text-red-300"><Trash2 size={15} /></button>
    </div>
  )
}
