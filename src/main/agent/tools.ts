import { promises as fsp } from 'fs'
import { dirname, resolve } from 'path'
import type { ToolSpec } from '../providers/types'
import type { BrowserManager } from '../browser/manager'
import type { UnrealClient } from '../unreal/client'
import { saveDoc, createCalendarEvent, listCalendarEvents, updateCalendarEvent, deleteCalendarEvent, createTodo, listTodos, updateTodo, completeTodo, deleteTodo, createReminder, listReminders, updateReminder, deleteReminder, listFeedSources, listFeedItems, getFeedItem, deleteFeedSource, setFeedItemState, markFeedRead, addMemory, searchMemories, listMemories, updateMemory, deleteMemory, listVaultItems, getVaultItem, createVaultItem, updateVaultItem, addVaultValuation, listVaultValuations, latestVaultValuations, listMtgWatchlist, getMtgWatch, createMtgWatch, updateMtgWatch, deleteMtgWatch, listMtgPrices, listMtgOwned, listMtgListings, sealedPriceSnapshot } from '../db'
import type { CalendarEvent, TodoItem, ReminderItem, VaultItem } from '../db'
import * as feed from '../feed'
import * as vault from '../vault'
import * as mtg from '../mtg'
import * as retail from '../retail'
import * as secretlair from '../secretlair'
import * as ev from '../ev'
import { resolveWorkspacePath } from '../workspace'
import type { ShellManager } from './shell'
import type { McpManager } from '../mcp'
import type { AppHostManager } from '../apphost'
import type { DesktopAppManager } from '../desktop/manager'
import { readSkill, saveSkill } from './skills'
import { schemaText, runQuery } from './dbquery'

const inWorkspace = resolveWorkspacePath

/** Coerce a model-supplied platform arg; the enum is advisory, not enforced. */

/** Coerce a loosely-typed {x,y,z} arg into a Vec3, defaulting missing axes. */
function toVec3(v: unknown, fallback = 0): { x: number; y: number; z: number } {
  const o = (v ?? {}) as Record<string, unknown>
  const n = (k: unknown) => (k == null || !Number.isFinite(Number(k)) ? fallback : Number(k))
  return { x: n(o.x), y: n(o.y), z: n(o.z) }
}

/** Coerce a loosely-typed {roll,pitch,yaw} arg into a Rot, defaulting missing axes to 0. */
function toRot(v: unknown): { roll: number; pitch: number; yaw: number } {
  const o = (v ?? {}) as Record<string, unknown>
  const n = (k: unknown) => (k == null || !Number.isFinite(Number(k)) ? 0 : Number(k))
  return { roll: n(o.roll), pitch: n(o.pitch), yaw: n(o.yaw) }
}

function parseLocalDate(dateText?: string): { y: number; m: number; d: number } {
  const now = new Date()
  const t = (dateText ?? 'today').trim().toLowerCase()
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!t || t === 'today') return { y: base.getFullYear(), m: base.getMonth(), d: base.getDate() }
  if (t === 'tomorrow') {
    base.setDate(base.getDate() + 1)
    return { y: base.getFullYear(), m: base.getMonth(), d: base.getDate() }
  }
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) }
  throw new Error(`Unsupported local date "${dateText}". Use today, tomorrow, or YYYY-MM-DD.`)
}

function parseLocalTime(timeText: string): { h: number; min: number } {
  const t = timeText.trim().toLowerCase().replace(/\s+/g, '')
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/)
  if (!m) throw new Error(`Unsupported local time "${timeText}". Use formats like 3:10 PM, 15:10, or 5pm.`)
  let h = Number(m[1])
  const min = m[2] == null ? 0 : Number(m[2])
  const meridiem = m[3]
  if (min < 0 || min > 59) throw new Error(`Invalid minutes in local time "${timeText}".`)
  if (meridiem) {
    if (h < 1 || h > 12) throw new Error(`Invalid 12-hour local time "${timeText}".`)
    if (meridiem === 'am') h = h === 12 ? 0 : h
    else h = h === 12 ? 12 : h + 12
  } else if (h < 0 || h > 23) {
    throw new Error(`Invalid 24-hour local time "${timeText}".`)
  }
  return { h, min }
}

function parseLocalDateTime(localText: string): number {
  const s = localText.trim()
  const m = s.match(/^(today|tomorrow|\d{4}-\d{1,2}-\d{1,2})[ t]+(.+)$/i)
  if (!m) throw new Error(`Unsupported local datetime "${localText}". Use "today 3:10 PM", "tomorrow 14:00", or "YYYY-MM-DD HH:mm".`)
  const date = parseLocalDate(m[1])
  const time = parseLocalTime(m[2])
  return new Date(date.y, date.m, date.d, time.h, time.min, 0, 0).getTime()
}

function localMs(args: Record<string, unknown>, epochKey: string, localKey: string): number | null {
  const epoch = args[epochKey]
  if (epoch != null) return Number(epoch)
  const local = args[localKey]
  if (typeof local === 'string' && local.trim()) return parseLocalDateTime(local)
  const date = args.date == null ? undefined : String(args.date)
  const time = args.time == null ? undefined : String(args.time)
  if (time) {
    const d = parseLocalDate(date)
    const tm = parseLocalTime(time)
    return new Date(d.y, d.m, d.d, tm.h, tm.min, 0, 0).getTime()
  }
  return null
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the embedded ATLIS browser to a URL. The user sees the page live. Returns the page title once loaded.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL or bare domain to open.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_read',
    description: 'Read the visible text content of the current page in the embedded browser.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser_snapshot',
    description: 'List the interactive elements (links, buttons, inputs) on the current page with numeric ids usable by browser_click / browser_type. Ids reset whenever the page navigates.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser_click',
    description: 'Click an interactive element by the id returned from browser_snapshot.',
    parameters: {
      type: 'object',
      properties: { element_id: { type: 'integer', description: 'Id from the latest browser_snapshot.' } },
      required: ['element_id']
    }
  },
  {
    name: 'browser_type',
    description: 'Type text into an input/textarea identified by browser_snapshot, optionally submitting the form (Enter).',
    parameters: {
      type: 'object',
      properties: {
        element_id: { type: 'integer' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter / submit the form after typing.' }
      },
      required: ['element_id', 'text']
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current page up or down by one viewport.',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down'] } },
      required: ['direction']
    }
  },
  {
    name: 'fs_list',
    description: 'List files and directories inside the workspace root. Paths are relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory to list, relative to the workspace root. Defaults to the root itself.' } }
    }
  },
  {
    name: 'fs_read',
    description: 'Read a text file inside the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the workspace root.' } },
      required: ['path']
    }
  },
  {
    name: 'fs_write',
    description: 'Create or overwrite a text file inside the workspace root. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'fs_replace',
    description: 'Edit a file inside the workspace root by exact string replacement. old_text must match exactly (including whitespace); fails if it matches zero times, or more than once without replace_all.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch a URL directly (no browser) and return its text content. Good for APIs and raw pages.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'calendar_create_event',
    description: 'Create a local calendar event. Use for scheduled time blocks such as work shifts, appointments, meetings, meals, or places the user needs to be.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start_at: { type: 'integer', description: 'Exact start time as Unix epoch milliseconds. Prefer start_at_local/date+time for natural-language user requests.' },
        start_at_local: { type: 'string', description: 'Local start date/time, e.g. "today 3:10 PM", "tomorrow 14:00", or "2026-06-13 15:10". Preferred for chat scheduling.' },
        date: { type: 'string', description: 'Local date for plain input, e.g. today, tomorrow, or YYYY-MM-DD.' },
        time: { type: 'string', description: 'Local time for plain input, e.g. 3:10 PM, 5pm, or 15:10.' },
        end_at: { type: 'integer', description: 'Optional exact end time as Unix epoch milliseconds.' },
        end_at_local: { type: 'string', description: 'Optional local end date/time.' },
        duration_minutes: { type: 'integer', description: 'Optional duration if end_at is omitted.' },
        all_day: { type: 'boolean' },
        timezone: { type: 'string' },
        location: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['title']
    }
  },
  {
    name: 'calendar_list_events',
    description: 'List local calendar events in a date range. Use when the user asks what is scheduled today, tomorrow, this week, etc.',
    parameters: {
      type: 'object',
      properties: {
        start_at: { type: 'integer', description: 'Range start as Unix epoch milliseconds.' },
        end_at: { type: 'integer', description: 'Range end as Unix epoch milliseconds.' },
        query: { type: 'string', description: 'Optional title search.' }
      },
      required: ['start_at', 'end_at']
    }
  },
  {
    name: 'calendar_update_event',
    description: 'Update a local calendar event by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, patch: { type: 'object' } },
      required: ['id', 'patch']
    }
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete/cancel a local calendar event by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'todo_create',
    description: 'Create a calendar-agnostic to-do item. Use for tasks the user wants/needs to accomplish unless they explicitly schedule a time block.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        due_at: { type: 'integer', description: 'Optional due date/time as Unix epoch milliseconds; does not make it a calendar event.' },
        scheduled_at: { type: 'integer', description: 'Optional intended work time as Unix epoch milliseconds; still remains a to-do.' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['title']
    }
  },
  {
    name: 'todo_list',
    description: 'List to-do items, optionally filtered by status, priority, dueBefore, or tag.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        dueBefore: { type: 'integer' },
        tag: { type: 'string' }
      }
    }
  },
  {
    name: 'todo_update',
    description: 'Update a to-do item by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, patch: { type: 'object' } }, required: ['id', 'patch'] }
  },
  {
    name: 'todo_complete',
    description: 'Mark a to-do item complete by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'todo_delete',
    description: 'Delete a to-do item by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'reminder_create',
    description: 'Create a reminder notification. Use when the user explicitly asks to be reminded at a time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        remind_at: { type: 'integer', description: 'Exact reminder time as Unix epoch milliseconds. Prefer remind_at_local/date+time for natural-language user requests.' },
        remind_at_local: { type: 'string', description: 'Local reminder date/time, e.g. "today 3:10 PM", "tomorrow 09:00", or "2026-06-13 15:10". Preferred for chat reminders.' },
        date: { type: 'string', description: 'Local date for plain input, e.g. today, tomorrow, or YYYY-MM-DD.' },
        time: { type: 'string', description: 'Local time for plain input, e.g. 3:10 PM, 5pm, or 15:10.' },
        linked_type: { type: 'string', enum: ['event', 'todo'] },
        linked_id: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'reminder_list',
    description: 'List reminders in an optional date range/status.',
    parameters: {
      type: 'object',
      properties: {
        start_at: { type: 'integer' },
        end_at: { type: 'integer' },
        status: { type: 'string', enum: ['pending', 'sent', 'dismissed'] }
      }
    }
  },
  {
    name: 'reminder_update',
    description: 'Update a reminder by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, patch: { type: 'object' } }, required: ['id', 'patch'] }
  },
  {
    name: 'reminder_delete',
    description: 'Delete a reminder by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'save_document',
    description: 'Save an HTML research document to the ATLIS document library. Author full, well-structured HTML (headings, tables, lists); ATLIS renders HTML natively and can derive Markdown from it on demand.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        html: { type: 'string', description: 'Complete HTML body content of the document.' }
      },
      required: ['title', 'html']
    }
  },
  {
    name: 'unreal_status',
    description: 'Check whether the Unreal Engine editor is reachable over Remote Control, and report engine/project info or the reason it is not connected. Call this before building if unsure.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'unreal_spawn_actor',
    description: 'Spawn an actor in the live UE level from an asset path (e.g. /Game/StarterContent/Shapes/Shape_Cube.Shape_Cube) or a class name (e.g. PointLight, DirectionalLight). Returns the created actor label.',
    parameters: {
      type: 'object',
      properties: {
        asset_path: { type: 'string', description: 'Asset path to spawn as a static mesh, e.g. /Game/StarterContent/Props/SM_Chair.SM_Chair. Provide this OR class_name.' },
        class_name: { type: 'string', description: 'Unreal class to spawn instead of an asset, e.g. PointLight, DirectionalLight, SpotLight, CameraActor.' },
        label: { type: 'string', description: 'Human-readable label for the new actor (shown in the World Outliner).' },
        location: { type: 'object', description: 'World location in cm.', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
        rotation: { type: 'object', description: 'Rotation in degrees (roll, pitch, yaw).', properties: { roll: { type: 'number' }, pitch: { type: 'number' }, yaw: { type: 'number' } } },
        scale: { type: 'object', description: 'Scale multiplier per axis (defaults to 1).', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } }
      }
    }
  },
  {
    name: 'unreal_set_transform',
    description: 'Move, rotate, and/or scale an existing actor identified by its label. Only the provided components change.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Label of the actor to modify (from unreal_list_actors or unreal_spawn_actor).' },
        location: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
        rotation: { type: 'object', properties: { roll: { type: 'number' }, pitch: { type: 'number' }, yaw: { type: 'number' } } },
        scale: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } }
      },
      required: ['label']
    }
  },
  {
    name: 'unreal_list_actors',
    description: 'List the actors currently in the open UE level, with their labels and world locations. Use to re-check scene state before editing.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'unreal_list_assets',
    description: 'List asset paths under a content directory (e.g. /Game or /Engine/BasicShapes) so you can spawn real, existing assets instead of guessing paths.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Content path to search, e.g. /Game/StarterContent/Props or /Engine/BasicShapes. Defaults to /Game.' }
      }
    }
  },
  {
    name: 'unreal_delete_actor',
    description: 'Delete an actor from the live UE level by the label it was given when spawned.',
    parameters: {
      type: 'object',
      properties: { label: { type: 'string', description: 'Label of the actor to delete.' } },
      required: ['label']
    }
  },
  {
    name: 'feed_add_source',
    description: "Add a source to the user's Feed (news aggregator). Accepts a YouTube channel URL or @handle, a subreddit (r/name), any blog/RSS/Atom feed URL, or a supported feedless site (e.g. 'anthropic' / anthropic.com/news, scraped directly) — the kind is auto-detected and the source resolved. Returns the created source.",
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'YouTube channel/@handle, r/subreddit, or blog/RSS URL.' },
        category: { type: 'string', description: 'Optional grouping label.' }
      },
      required: ['input']
    }
  },
  {
    name: 'feed_list_sources',
    description: 'List the sources currently configured in the Feed, with their id, kind, title, and last fetch status.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'feed_remove_source',
    description: 'Remove a Feed source (and its items) by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'feed_refresh',
    description: 'Fetch the newest items for one Feed source (by id) or all sources when no id is given. Returns how many new items were found.',
    parameters: { type: 'object', properties: { source_id: { type: 'string', description: 'Optional source id; omit to refresh all.' } } }
  },
  {
    name: 'feed_list_items',
    description: 'List items from the Feed timeline, newest first. Use to see what is new across the aggregated sources.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'unread', 'saved'], description: 'Defaults to all.' },
        kind: { type: 'string', enum: ['youtube', 'reddit', 'rss', 'site'] },
        source_id: { type: 'string' },
        limit: { type: 'integer', description: 'Max items (default 30).' }
      }
    }
  },
  {
    name: 'feed_open_item',
    description: "Open a Feed item's link in the embedded ATLIS browser (the user sees it live) and mark it read. Use the item id from feed_list_items.",
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'feed_save_item',
    description: 'Bookmark (save) or unsave a Feed item by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, saved: { type: 'boolean', description: 'true to save (default), false to unsave.' } },
      required: ['id']
    }
  },
  {
    name: 'feed_mark_read',
    description: 'Mark a single Feed item read by id, or mark everything read when no id is given.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Optional item id; omit to mark all read.' } } }
  },
  {
    name: 'feed_hide_item',
    description: 'Hide a Feed item from the timeline by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'shell_exec',
    description: 'Run a PowerShell command in a persistent per-session shell (cwd, variables and env persist between calls; starts in the workspace root). For anything long-running (servers, builds, watchers) use shell_bg_start instead.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command line to run.' },
        timeout_seconds: { type: 'integer', description: 'Max seconds to wait (default 60, max 300). On timeout the shell is reset.' }
      },
      required: ['command']
    }
  },
  {
    name: 'shell_bg_start',
    description: 'Start a long-running command (dev server, build watch, download…) as a background process. Returns a process id for shell_bg_output / shell_bg_wait / shell_bg_kill.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'PowerShell command line to run in the background.' } },
      required: ['command']
    }
  },
  {
    name: 'shell_bg_output',
    description: 'Read the latest output of a background process by id (also reports whether it is still running).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        tail_chars: { type: 'integer', description: 'How much of the tail to return (default 6000).' }
      },
      required: ['id']
    }
  },
  {
    name: 'shell_bg_wait',
    description: 'Wait until a background process prints output matching a regex (e.g. "listening on port \\d+" or "error"), it exits, or the timeout passes. Avoids polling.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        pattern: { type: 'string', description: 'Case-insensitive regex to watch for in the output.' },
        timeout_seconds: { type: 'integer', description: 'Max seconds to wait (default 60, max 300).' }
      },
      required: ['id', 'pattern']
    }
  },
  {
    name: 'shell_bg_kill',
    description: 'Kill a background process (and its child processes) by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'shell_bg_list',
    description: 'List background processes started in this session with their status.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'app_launch',
    description: "Launch one of the user's configured apps in a managed sandbox (fresh run directory, own port). Waits for the app's ready signal. If the app exposes an MCP endpoint its tools become available as mcp__app-<name>__* on your NEXT turn — call app_launch, then use those tools to drive and inspect the app for E2E testing.",
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App name as configured in Settings → Apps (see app_status for the list).' } },
      required: ['name']
    }
  },
  {
    name: 'app_status',
    description: 'List the configured launchable apps and their live state (stopped/starting/running, pid, port, attached MCP tools).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'app_logs',
    description: "Read the latest stdout/stderr of a launched app — check this after driving the app to catch errors or warnings it printed.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tail_chars: { type: 'integer', description: 'How much of the tail to return (default 6000).' }
      },
      required: ['name']
    }
  },
  {
    name: 'app_open_ui',
    description: "Open a running app's UI in the embedded ATLIS browser (the user sees it live). The browser_* tools then work on it: browser_snapshot / browser_click / browser_type / browser_read.",
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'app_stop',
    description: 'Stop a launched app (kills its process tree, detaches its MCP tools). The sandbox run directory is kept for inspection.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'desktop_launch',
    description: "Find or start an existing desktop application (Discord, a game, anything already installed and configured in Settings → Desktop). If a matching window is already open it's adopted as-is (nothing new spawned); otherwise the configured command is run and the window is waited for. Call desktop_screenshot next to see it.",
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App name as configured in Settings → Desktop.' } },
      required: ['name']
    }
  },
  {
    name: 'desktop_screenshot',
    description: "Take a screenshot of a launched desktop app's window so you can see its current state. Always do this before acting, and again after each click/type/key to confirm the effect — there is no other way to observe what happened.",
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'desktop_click',
    description: "Click inside a desktop app's window at coordinates from the LAST desktop_screenshot (0,0 = top-left of that image). Brings the window to the foreground and moves the real cursor there — this is a real click, not simulated in the background.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'integer', description: 'X coordinate in the last screenshot\'s pixel space.' },
        y: { type: 'integer', description: 'Y coordinate in the last screenshot\'s pixel space.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Defaults to left.' },
        double_click: { type: 'boolean' }
      },
      required: ['name', 'x', 'y']
    }
  },
  {
    name: 'desktop_type',
    description: 'Type text into whatever currently has focus in a desktop app (click the target field with desktop_click first). Brings the window to the foreground and sends real keystrokes.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' }
      },
      required: ['name', 'text']
    }
  },
  {
    name: 'desktop_key',
    description: 'Send a key combo to a desktop app, e.g. "Enter", "Ctrl+Enter", "Ctrl+A", "Escape", "Tab".',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, keys: { type: 'string' } },
      required: ['name', 'keys']
    }
  },
  {
    name: 'desktop_status',
    description: 'List configured desktop apps and whether each is currently tracked/running.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'desktop_stop',
    description: "Stop tracking a desktop app. Only kills the process if ATLIS spawned it — an app that was already running before desktop_launch adopted it is left alone.",
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'mtg_search',
    description: "Search Magic: The Gathering CARDS by plain English — card name plus optionally a set name, e.g. \"arcane signet hobbit\". Set names and treatment words (foil, dwarvish, borderless…) are resolved automatically, so you do NOT need set codes. Real Scryfall syntax (set:hoc, rarity:mythic) also works verbatim. Returns each printing's scryfall id, set, collector number, finishes, and current USD prices per finish.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Max printings to return (default 20).' } },
      required: ['query']
    }
  },
  {
    name: 'mtg_search_sealed',
    description: 'Search SEALED Magic products — booster boxes, cases, packs, bundles, Secret Lair drops. Plain English, e.g. "secret lair orks" or "hobbit collector booster". Returns each product with its TCGplayer product id, which is what mtg_watch_add needs for sealed. Note sealed products are NOT cards and never appear in mtg_search.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'mtg_upcoming_sets',
    description: 'Upcoming Magic set releases with street dates and how far away they are. Use for "what is coming out", preorder timing, or prerelease planning. Street dates are mirrored into the Planner calendar automatically.',
    parameters: { type: 'object', properties: { ahead_days: { type: 'integer', description: 'Look-ahead window, default 540.' } } }
  },
  {
    name: 'mtg_ev_board',
    description: "The standing expected-value board for sealed Magic product: what each booster pack, box, case, bundle and Commander deck is worth to open versus what it costs. Use for 'what is worth buying/opening right now', 'is this box +EV', or ranking product by value. Rows marked deterministic have exactly-known contents (decks); simulated rows are random (boosters) and their MEDIAN matters more than their mean. Pass scan:true only when the user wants fresh products evaluated — it is slow.",
    parameters: {
      type: 'object',
      properties: {
        positive_only: { type: 'boolean', description: 'Only products whose EV beats their price.' },
        kind: { type: 'string', enum: ['pack', 'box', 'case', 'deck', 'bundle'], description: 'Restrict to one product line.' },
        limit: { type: 'integer', description: 'Rows to return, default 20.' },
        scan: { type: 'boolean', description: 'Evaluate new products first (slow — a minute or more).' }
      }
    }
  },
  {
    name: 'mtg_sealed_contents',
    description: "What is actually inside a sealed product, and whether its cards are worth more than the product costs. Works for anything with DETERMINED contents — Commander decks, precons, 'set of N' bundles. Booster boxes hold random packs and cannot be itemised: use mtg_pack_ev for those. Get the uuid from mtg_search_sealed. Answers 'are these decks a good investment' with real numbers.",
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'MTGJSON sealed product uuid, from mtg_search_sealed.' },
        limit: { type: 'integer', description: 'How many of the most valuable cards to list, default 15.' }
      },
      required: ['uuid']
    }
  },
  {
    name: 'mtg_upcoming_secret_lairs',
    description: 'Secret Lair drops that have been ANNOUNCED but are not on sale yet — superdrop name, the lairs inside it, on-sale date and MSRP. Use for "what Secret Lairs are coming", planning a preorder, or budgeting a superdrop. Secret Lairs are limited runs sold direct, so the announcement window is the only time to plan. Pass refresh:true to re-pull the feed first.',
    parameters: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: 'Re-pull the upstream list before answering. Normally unnecessary — it syncs twice a day.' } }
    }
  },
  {
    name: 'mtg_watchlist',
    description: "List everything on the user's Magic watchlist (things they want but do not own) with each entry's id, tracked finish, latest price, and target price. Owned copies are NOT here — use mtg_owned for those.",
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'mtg_owned',
    description: "List the Magic cards and sealed products the user OWNS (their Vault holdings that carry a live price feed), most valuable first, with quantity, latest price, and how many days of price history exist. For 'what is my collection worth' pass summary: true (totals plus the top holdings, not every line). For 'which of my cards are worth more than $X' pass min_price rather than filtering a full list yourself.",
    parameters: {
      type: 'object',
      properties: {
        min_price: { type: 'number', description: 'Only holdings whose latest UNIT price is at or above this many USD, e.g. 2 for "cards over $2".' },
        kind: { type: 'string', enum: ['card', 'sealed', 'all'], description: 'card = singles (Scryfall), sealed = boxes/packs/decks (TCGplayer). Defaults to all.' },
        limit: { type: 'number', description: 'Maximum rows to return (default: all).' },
        summary: { type: 'boolean', description: 'Return only totals (value, holdings, copies, cards vs sealed) and the 10 most valuable holdings.' }
      }
    }
  },
  {
    name: 'mtg_watch_add',
    description: 'Add a card or sealed product to the watchlist so its price is tracked daily. For a CARD pass ext_source "scryfall" and the scryfall id from mtg_search, plus which finish. For SEALED pass ext_source "tcgplayer" and the tcgplayer product id from mtg_search_sealed. Set target_price to have the user notified when it drops to or below that.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name, e.g. "Arcane Signet".' },
        ext_source: { type: 'string', enum: ['scryfall', 'tcgplayer'], description: 'scryfall for cards, tcgplayer for sealed.' },
        ext_id: { type: 'string', description: 'Scryfall card id, or TCGplayer product id for sealed.' },
        variant: { type: 'string', enum: ['nonfoil', 'foil', 'etched', 'sealed'], description: 'Finish for cards; use "sealed" for sealed product.' },
        kind: { type: 'string', enum: ['card', 'sealed'], description: 'Defaults to card.' },
        set_code: { type: 'string' },
        collector_number: { type: 'string' },
        target_price: { type: 'number', description: 'Alert when the price is at or below this (USD).' },
        notes: { type: 'string' }
      },
      required: ['name', 'ext_source', 'ext_id']
    }
  },
  {
    name: 'mtg_watch_update',
    description: "Change a watchlist entry — most often its target_price, or alert_enabled to mute it. Get ids from mtg_watchlist.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        target_price: { type: 'number', description: 'Null/omit leaves it unchanged; pass 0 to clear via alert_enabled instead.' },
        alert_enabled: { type: 'boolean' },
        notes: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'mtg_watch_remove',
    description: 'Remove an entry from the watchlist. This does NOT delete its collected price history, which stays keyed to the card/product.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'mtg_price_history',
    description: "Daily price history for one card printing or sealed product, newest first. Use to answer whether something is rising or falling, and by how much. Get ext_id/variant from mtg_watchlist, mtg_owned, or a search.",
    parameters: {
      type: 'object',
      properties: {
        ext_id: { type: 'string', description: 'Scryfall card id, or TCGplayer product id for sealed.' },
        variant: { type: 'string', description: 'nonfoil | foil | etched | sealed.' },
        days: { type: 'integer', description: 'How many points to return (default 60).' }
      },
      required: ['ext_id', 'variant']
    }
  },
  {
    name: 'mtg_refresh_prices',
    description: 'Pull today\'s prices for everything tracked (watchlist + owned) right now, instead of waiting for the hourly refresh. Also fires any target-price alerts. Prices only move about once a day upstream, so do not call this repeatedly.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'mtg_backfill_history',
    description: "Pull up to 90 days of PAST prices for every tracked card from MTGJSON, filling in history from before the card was added. SLOW and heavy — it streams roughly 900MB and takes several minutes — so run it once, only when the user explicitly asks, and never speculatively. Cards only; sealed products have no MTGJSON price data.",
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'mtg_track_sealed_set',
    description: "Follow (or unfollow) a SET so every one of its sealed products — booster boxes, cases, packs, bundles, Commander decks — gets priced once a day. A set has roughly 16-25 sealed products, so this beats adding each one to the watchlist by hand. Use it to watch a release or preorder curve.",
    parameters: {
      type: 'object',
      properties: {
        set_code: { type: 'string', description: 'Set code, e.g. hob, fra.' },
        follow: { type: 'boolean', description: 'False to stop tracking. Defaults to true.' }
      },
      required: ['set_code']
    }
  },
  {
    name: 'mtg_sealed_prices',
    description: "Current price of every sealed product in a set, with the change over a window and how many days of history exist. Shows what a booster box, case, pack, bundle or Commander deck is going for right now.",
    parameters: {
      type: 'object',
      properties: {
        set_code: { type: 'string' },
        days: { type: 'integer', description: 'Comparison window, default 60.' }
      },
      required: ['set_code']
    }
  },
  {
    name: 'mtg_pack_ev',
    description: "Expected value of ripping a booster from a set, by Monte Carlo simulation. Give a set name/code, booster type ('collector' or 'play'), and optionally what a pack costs. Returns mean AND median (they differ a lot — the mean is dragged up by rare chase cards), 10th/90th percentiles, the chance a pack beats its price, and which cards drive the number. IMPORTANT when reporting: the median is what a typical pack returns, prices are retail asks rather than what the user could sell for (buylist is roughly half), and unpriced serialized/headliner cards are excluded entirely so the true ceiling is higher than the maths shows.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Set name or code.' },
        booster_type: { type: 'string', enum: ['collector', 'play'], description: 'Defaults to collector.' },
        pack_price: { type: 'number', description: 'What a pack costs, to compute chance of profit.' }
      },
      required: ['query']
    }
  },
  {
    name: 'mtg_set_value',
    description: "Value an entire Magic set and rank its cards by price — i.e. the chase-card list. Takes a set NAME or code (\"hobbit\", \"reality fracture\", \"hoc\") and covers the whole set family, so \"hobbit\" includes both the main set and its Eternal sheet. Ranks by the BEST finish, not the nonfoil price, because chase cards are usually foil-only. Also returns what completing the set costs. Results are cached ~6h.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Set name or code.' },
        limit: { type: 'integer', description: 'How many top cards to list (default 15).' },
        force: { type: 'boolean', description: 'Bypass the cache and re-pull from Scryfall.' }
      },
      required: ['query']
    }
  },
  {
    name: 'mtg_find_retailers',
    description: "Find where a watchlist entry can be bought. Checks TCGplayer, Card Kingdom, Target, Best Buy, Amazon and eBay-sold, resolving an exact product page where possible and falling back to that retailer's search page. Reports when NOTHING resolved to an exact product, which means the user should paste a product URL with mtg_add_retailer_link. Reads public pages only — never buys anything.",
    parameters: { type: 'object', properties: { watch_id: { type: 'string' } }, required: ['watch_id'] }
  },
  {
    name: 'mtg_retailers',
    description: 'List the known buy links for a watchlist entry with each one\'s stock status, price, and how trustworthy the link is (product = exact, searched = name-matched, search = results page, manual = user-supplied).',
    parameters: { type: 'object', properties: { watch_id: { type: 'string' } }, required: ['watch_id'] }
  },
  {
    name: 'mtg_add_retailer_link',
    description: 'Attach a product URL the user (or you) found, when automatic discovery could not resolve one. The retailer is inferred from the URL, and price/stock are read immediately if that retailer is readable.',
    parameters: {
      type: 'object',
      properties: { watch_id: { type: 'string' }, url: { type: 'string' } },
      required: ['watch_id', 'url']
    }
  },
  {
    name: 'mtg_refresh_stock',
    description: 'Re-check stock and price on every resolved buy link now. Reports any status transitions (e.g. out_of_stock -> in_stock). Plain search links are skipped since a results page proves nothing.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'vault_list_items',
    description: "List the user's collectibles Vault inventory (coins, bullion, knives, …) with each item's id, key attributes, and latest melt/market values. Start here for any valuation or inventory question.",
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', description: 'Optional filter: coin, bullion, knife, other.' } }
    }
  },
  {
    name: 'vault_get_item',
    description: 'Get one Vault item in full detail, including its complete valuation history (melt and market estimates over time).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'vault_add_item',
    description: 'Add a collectible to the Vault. For coins/bullion set metal + metal_weight_ozt (troy oz of that metal per single item) so melt value can be computed automatically.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "1921 Morgan Silver Dollar", "Buck 110 Folding Hunter".' },
        category: { type: 'string', enum: ['coin', 'bullion', 'knife', 'other'], description: 'Defaults to coin.' },
        year: { type: 'string' },
        maker: { type: 'string', description: 'Mint, manufacturer, or brand.' },
        grade: { type: 'string', description: 'Condition or certified grade, e.g. MS-63, VF-20, "excellent, unsharpened".' },
        quantity: { type: 'integer', description: 'How many identical pieces (default 1).' },
        metal: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium', 'copper'], description: 'Primary precious-metal content, if any.' },
        metal_weight_ozt: { type: 'number', description: 'Troy oz of that metal PER ITEM, e.g. 0.7734 for a Morgan dollar.' },
        purchase_price: { type: 'number', description: 'Total paid in USD for the whole quantity.' },
        purchase_date: { type: 'string', description: 'YYYY-MM-DD if known.' },
        notes: { type: 'string' }
      },
      required: ['name']
    }
  },
  {
    name: 'vault_update_item',
    description: "Update a Vault item's fields by id (same fields as vault_add_item).",
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, patch: { type: 'object', description: 'Fields to change.' } },
      required: ['id', 'patch']
    }
  },
  {
    name: 'vault_spot_prices',
    description: 'Current precious-metal spot prices in USD per troy oz (gold, silver, platinum, palladium, copper) plus a fresh melt value for every metal-bearing Vault item.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'vault_record_valuation',
    description: "Record a market-value estimate for a Vault item after researching comparable sales (eBay sold listings, auction results, PCGS/NGC/Numista price guides, dealer listings). Values are USD for the item's WHOLE quantity. Always cite what the estimate is based on in notes. This appends to the item's valuation history — the user's 'Beckett list'.",
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        value_mid: { type: 'number', description: 'Best single estimate in USD for the whole quantity.' },
        value_low: { type: 'number', description: 'Conservative end of the range.' },
        value_high: { type: 'number', description: 'Optimistic end of the range.' },
        source: { type: 'string', description: 'Short label for where this came from, e.g. "eBay sold comps, June 2026".' },
        notes: { type: 'string', description: 'Rationale + citations: which comps, their prices, condition caveats, confidence.' }
      },
      required: ['item_id', 'value_mid']
    }
  },
  {
    name: 'db_schema',
    description: "Show the tables and columns of ATLIS's own SQLite database (Magic prices, Vault, planner, feed, land, drops, chat history…) plus notes on how they relate. Call this before writing a db_query. Pass filter to show only tables whose name contains it, e.g. \"mtg\".",
    parameters: { type: 'object', properties: { filter: { type: 'string', description: 'Substring of table names to show.' } } }
  },
  {
    name: 'db_query',
    description: "Run ONE read-only SQLite SELECT against ATLIS's database and get rows back (max 200). Use when no purpose-built tool answers the question. Writes are impossible and the settings table is off-limits. Prefer aggregates, WHERE and LIMIT over pulling whole tables.",
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single SELECT or WITH … SELECT statement.' } },
      required: ['sql']
    }
  },
  {
    name: 'memory_save',
    description: "Save a durable fact to persistent cross-session memory (about the user, their projects, stable preferences, environment constraints). Save declarative facts, not instructions or session-specific details.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, phrased so it makes sense months from now without this conversation.' },
        category: { type: 'string', description: 'Short grouping label, e.g. user, project, preference, environment. Defaults to general.' }
      },
      required: ['text']
    }
  },
  {
    name: 'memory_search',
    description: 'Keyword-search persistent memory (full-text). Use before asking the user something they may have told you in an earlier session.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Max results (default 12).' } },
      required: ['query']
    }
  },
  {
    name: 'memory_list',
    description: 'List stored memories, optionally filtered by category, newest first.',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string' }, limit: { type: 'integer', description: 'Default 50.' } }
    }
  },
  {
    name: 'memory_update',
    description: 'Rewrite a stored memory (by id or unambiguous id prefix) when the fact changed or was phrased badly.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id or prefix from memory_list / the prompt.' },
        text: { type: 'string', description: 'The corrected fact.' },
        category: { type: 'string' }
      },
      required: ['id', 'text']
    }
  },
  {
    name: 'memory_delete',
    description: 'Delete a stored memory (by id or unambiguous id prefix) that is wrong or obsolete.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'skill_read',
    description: 'Load the full SKILL.md of a learned skill by name (the prompt lists available skills with their descriptions). Do this before starting a task a skill covers.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'skill_save',
    description: "Save (or overwrite) a skill — a reusable procedure that worked — to the workspace skills library. Write the body as markdown with sections like Procedure, Pitfalls, Verification. Do this after completing a non-obvious multi-step task the user may want repeated.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case name, e.g. deploy-vite-app.' },
        description: { type: 'string', description: 'One line: what this skill accomplishes.' },
        when_to_use: { type: 'string', description: 'One line: the situations that should trigger it.' },
        body: { type: 'string', description: 'Markdown body: Procedure steps, Pitfalls, Verification.' }
      },
      required: ['name', 'description', 'body']
    }
  }
]

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { browser: BrowserManager; unreal: UnrealClient; shell: ShellManager; mcp: McpManager; apps: AppHostManager; desktop: DesktopAppManager; sessionId: string; notifyDocsChanged: () => void; notifyPlannerChanged: () => void; notifyFeedChanged: () => void; notifyVaultChanged: () => void; notifyMtgChanged: () => void }
): Promise<string | { text: string; imageMime: string; imageBase64: string }> {
  if (name.startsWith('mcp__')) return ctx.mcp.call(name, args)
  switch (name) {
    case 'browser_navigate': {
      ctx.browser.setVisible(true)
      await ctx.browser.navigate(String(args.url))
      await new Promise((r) => setTimeout(r, 1200))
      const s = ctx.browser.state()
      return `Loaded "${s.title}" at ${s.url}`
    }
    case 'browser_read': {
      const page = await ctx.browser.readPage()
      return `# ${page.title}\nURL: ${page.url}\n\n${page.text}`
    }
    case 'browser_snapshot': {
      const snap = await ctx.browser.snapshot()
      return snap || 'No interactive elements found.'
    }
    case 'browser_click': {
      const result = await ctx.browser.click(Number(args.element_id))
      await new Promise((r) => setTimeout(r, 800))
      return result
    }
    case 'browser_type':
      return ctx.browser.type(Number(args.element_id), String(args.text), Boolean(args.submit))
    case 'browser_scroll': {
      await ctx.browser.scroll(args.direction === 'up' ? 'up' : 'down')
      return `Scrolled ${args.direction}.`
    }
    case 'fs_list': {
      const dir = inWorkspace(String(args.path ?? '.'))
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      const lines = await Promise.all(
        entries.slice(0, 300).map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`
          const size = (await fsp.stat(resolve(dir, e.name)).catch(() => null))?.size ?? 0
          return `${e.name}  (${size.toLocaleString()} B)`
        })
      )
      return `${dir}\n${lines.join('\n') || '(empty)'}${entries.length > 300 ? `\n…and ${entries.length - 300} more` : ''}`
    }
    case 'fs_read': {
      const file = inWorkspace(String(args.path))
      const text = await fsp.readFile(file, 'utf8')
      return text.length > 60000 ? `${text.slice(0, 60000)}\n…[truncated, ${text.length.toLocaleString()} chars total]` : text
    }
    case 'fs_write': {
      const file = inWorkspace(String(args.path))
      await fsp.mkdir(dirname(file), { recursive: true })
      await fsp.writeFile(file, String(args.content), 'utf8')
      return `Wrote ${String(args.content).length.toLocaleString()} chars to ${file}`
    }
    case 'fs_replace': {
      const file = inWorkspace(String(args.path))
      const oldText = String(args.old_text)
      const text = await fsp.readFile(file, 'utf8')
      const count = text.split(oldText).length - 1
      if (count === 0) return 'Error: old_text not found in file — read the file again and match exactly, including whitespace.'
      if (count > 1 && !args.replace_all) return `Error: old_text matches ${count} times — provide more context or set replace_all.`
      const next = args.replace_all ? text.split(oldText).join(String(args.new_text)) : text.replace(oldText, String(args.new_text))
      await fsp.writeFile(file, next, 'utf8')
      return `Replaced ${args.replace_all ? count : 1} occurrence(s) in ${file}`
    }
    case 'fetch_url': {
      const res = await fetch(String(args.url), { headers: { 'User-Agent': 'ATLIS/0.1' } })
      const body = await res.text()
      const stripped = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n')
      return `HTTP ${res.status}\n${stripped.slice(0, 40000)}`
    }
    case 'calendar_create_event': {
      const start = localMs(args, 'start_at', 'start_at_local')
      if (start == null) return 'Error: calendar_create_event requires start_at, start_at_local, or date+time.'
      const duration = args.duration_minutes == null ? null : Number(args.duration_minutes)
      const explicitEnd = localMs(args, 'end_at', 'end_at_local')
      const end = explicitEnd == null ? (duration ? start + duration * 60_000 : null) : explicitEnd
      const ev = createCalendarEvent({
        title: String(args.title),
        start_at: start,
        end_at: end,
        all_day: Boolean(args.all_day),
        timezone: args.timezone == null ? null : String(args.timezone),
        location: args.location == null ? null : String(args.location),
        notes: args.notes == null ? null : String(args.notes),
        tags: args.tags
      })
      ctx.notifyPlannerChanged()
      return `Created calendar event "${ev.title}" (${ev.id}) at ${new Date(ev.start_at).toLocaleString()}${ev.end_at ? ` until ${new Date(ev.end_at).toLocaleString()}` : ''}.`
    }
    case 'calendar_list_events': {
      const rows = listCalendarEvents(Number(args.start_at), Number(args.end_at), args.query == null ? undefined : String(args.query))
      if (!rows.length) return 'No calendar events found.'
      return rows.map((e) => `- ${e.id}: ${e.title} — ${new Date(e.start_at).toLocaleString()}${e.end_at ? ` to ${new Date(e.end_at).toLocaleString()}` : ''}${e.location ? ` @ ${e.location}` : ''}`).join('\n')
    }
    case 'calendar_update_event': {
      updateCalendarEvent(String(args.id), (args.patch ?? {}) as Partial<CalendarEvent> & { tags?: unknown })
      ctx.notifyPlannerChanged()
      return `Updated calendar event ${String(args.id)}.`
    }
    case 'calendar_delete_event': {
      deleteCalendarEvent(String(args.id))
      ctx.notifyPlannerChanged()
      return `Deleted calendar event ${String(args.id)}.`
    }
    case 'todo_create': {
      const todo = createTodo({
        title: String(args.title),
        notes: args.notes == null ? null : String(args.notes),
        priority: args.priority == null ? 'normal' : String(args.priority),
        due_at: args.due_at == null ? null : Number(args.due_at),
        scheduled_at: args.scheduled_at == null ? null : Number(args.scheduled_at),
        tags: args.tags
      })
      ctx.notifyPlannerChanged()
      return `Created to-do "${todo.title}" (${todo.id}).`
    }
    case 'todo_list': {
      const rows = listTodos({
        status: args.status == null ? undefined : String(args.status),
        priority: args.priority == null ? undefined : String(args.priority),
        dueBefore: args.dueBefore == null ? null : Number(args.dueBefore),
        tag: args.tag == null ? undefined : String(args.tag)
      })
      if (!rows.length) return 'No to-dos found.'
      return rows.map((t) => `- ${t.id}: [${t.status}] ${t.title} (${t.priority})${t.due_at ? ` due ${new Date(t.due_at).toLocaleString()}` : ''}`).join('\n')
    }
    case 'todo_update': {
      updateTodo(String(args.id), (args.patch ?? {}) as Partial<TodoItem> & { tags?: unknown })
      ctx.notifyPlannerChanged()
      return `Updated to-do ${String(args.id)}.`
    }
    case 'todo_complete': {
      completeTodo(String(args.id))
      ctx.notifyPlannerChanged()
      return `Completed to-do ${String(args.id)}.`
    }
    case 'todo_delete': {
      deleteTodo(String(args.id))
      ctx.notifyPlannerChanged()
      return `Deleted to-do ${String(args.id)}.`
    }
    case 'reminder_create': {
      const remindAt = localMs(args, 'remind_at', 'remind_at_local')
      if (remindAt == null) return 'Error: reminder_create requires remind_at, remind_at_local, or date+time.'
      const r = createReminder({
        title: String(args.title),
        remind_at: remindAt,
        linked_type: args.linked_type == null ? null : String(args.linked_type),
        linked_id: args.linked_id == null ? null : String(args.linked_id)
      })
      ctx.notifyPlannerChanged()
      return `Created reminder "${r.title}" (${r.id}) for ${new Date(r.remind_at).toLocaleString()}.`
    }
    case 'reminder_list': {
      const rows = listReminders(args.start_at == null ? null : Number(args.start_at), args.end_at == null ? null : Number(args.end_at), args.status == null ? undefined : String(args.status))
      if (!rows.length) return 'No reminders found.'
      return rows.map((r) => `- ${r.id}: [${r.status}] ${r.title} — ${new Date(r.remind_at).toLocaleString()}`).join('\n')
    }
    case 'reminder_update': {
      updateReminder(String(args.id), (args.patch ?? {}) as Partial<ReminderItem>)
      ctx.notifyPlannerChanged()
      return `Updated reminder ${String(args.id)}.`
    }
    case 'reminder_delete': {
      deleteReminder(String(args.id))
      ctx.notifyPlannerChanged()
      return `Deleted reminder ${String(args.id)}.`
    }
    case 'unreal_status': {
      const s = await ctx.unreal.status()
      return `${s.connected ? 'CONNECTED' : 'DISCONNECTED'} (${s.host}:${s.port}) — ${s.detail}`
    }
    case 'unreal_spawn_actor': {
      const assetPath = args.asset_path == null ? '' : String(args.asset_path)
      const className = args.class_name == null ? '' : String(args.class_name)
      if (!assetPath && !className) return 'Error: provide asset_path or class_name.'
      const location = toVec3(args.location, 0)
      const rotation = toRot(args.rotation)
      const label = args.label == null ? undefined : String(args.label)
      const scale = args.scale == null ? undefined : toVec3(args.scale, 1)
      const finalLabel = assetPath
        ? await ctx.unreal.spawnFromObject(assetPath, location, rotation, label, scale)
        : await ctx.unreal.spawnFromClass(className, location, rotation, label, scale)
      return `Spawned "${finalLabel}" at (${location.x}, ${location.y}, ${location.z}).`
    }
    case 'unreal_set_transform': {
      const label = String(args.label)
      const t: { location?: { x: number; y: number; z: number }; rotation?: { roll: number; pitch: number; yaw: number }; scale?: { x: number; y: number; z: number } } = {}
      if (args.location != null) t.location = toVec3(args.location, 0)
      if (args.rotation != null) t.rotation = toRot(args.rotation)
      if (args.scale != null) t.scale = toVec3(args.scale, 1)
      if (!t.location && !t.rotation && !t.scale) return 'Error: provide at least one of location, rotation, or scale.'
      await ctx.unreal.setTransform(label, t)
      return `Updated "${label}".`
    }
    case 'unreal_list_actors':
      return await ctx.unreal.listActors()
    case 'unreal_list_assets': {
      const path = args.path == null ? '/Game' : String(args.path)
      const assets = await ctx.unreal.searchAssets(path)
      if (!assets.length) return `No assets found under ${path}.`
      return `${assets.length} asset(s) under ${path}:\n${assets.slice(0, 200).join('\n')}`
    }
    case 'unreal_delete_actor': {
      await ctx.unreal.destroyActor(String(args.label))
      return `Deleted "${String(args.label)}".`
    }
    case 'save_document': {
      const doc = saveDoc({ title: String(args.title), html: String(args.html), session_id: ctx.sessionId })
      ctx.notifyDocsChanged()
      return `Saved document "${doc.title}" (id ${doc.id}) to the library.`
    }
    case 'feed_add_source': {
      const source = await feed.addSource(String(args.input), args.category == null ? null : String(args.category))
      ctx.notifyFeedChanged()
      return `Added ${source.kind} source "${source.title}" (id ${source.id})${source.last_error ? ` — but first fetch failed: ${source.last_error}` : '.'}`
    }
    case 'feed_list_sources': {
      const rows = listFeedSources()
      if (!rows.length) return 'No feed sources configured yet.'
      return rows.map((s) => `- ${s.id}: [${s.kind}] ${s.title}${s.last_error ? ` (error: ${s.last_error})` : ''}`).join('\n')
    }
    case 'feed_remove_source': {
      deleteFeedSource(String(args.id))
      ctx.notifyFeedChanged()
      return `Removed feed source ${String(args.id)}.`
    }
    case 'feed_refresh': {
      const sourceId = args.source_id == null ? undefined : String(args.source_id)
      const r = sourceId ? await feed.refreshSource(sourceId) : await feed.refreshAll()
      ctx.notifyFeedChanged()
      if ('error' in r && r.error) return `Refresh failed: ${r.error}`
      const scope = sourceId ? 'source' : `${(r as { sources: number }).sources} source(s)`
      return `Refreshed ${scope}: ${r.added} new item(s).`
    }
    case 'feed_list_items': {
      const rows = listFeedItems({
        filter: args.filter == null ? 'all' : (String(args.filter) as 'all' | 'unread' | 'saved'),
        kind: args.kind == null ? undefined : String(args.kind),
        sourceId: args.source_id == null ? undefined : String(args.source_id),
        limit: args.limit == null ? 30 : Number(args.limit)
      })
      if (!rows.length) return 'No feed items found.'
      return rows
        .map((it) => {
          const meta = [it.source_title, it.score != null ? `▲${it.score}` : '', it.comments != null ? `${it.comments}c` : '', it.is_read ? '' : 'NEW']
            .filter(Boolean)
            .join(' · ')
          return `- ${it.id}: ${it.title}\n    ${meta} — ${it.url}`
        })
        .join('\n')
    }
    case 'feed_open_item': {
      const item = getFeedItem(String(args.id))
      if (!item) return `Feed item ${String(args.id)} not found.`
      setFeedItemState(item.id, { is_read: true })
      ctx.browser.setVisible(true)
      await ctx.browser.navigate(item.url)
      ctx.notifyFeedChanged()
      await new Promise((r) => setTimeout(r, 1000))
      return `Opened "${item.title}" in the browser (${item.url}).`
    }
    case 'feed_save_item': {
      const saved = args.saved == null ? true : Boolean(args.saved)
      setFeedItemState(String(args.id), { is_saved: saved })
      ctx.notifyFeedChanged()
      return `${saved ? 'Saved' : 'Unsaved'} feed item ${String(args.id)}.`
    }
    case 'feed_mark_read': {
      if (args.id == null) markFeedRead()
      else setFeedItemState(String(args.id), { is_read: true })
      ctx.notifyFeedChanged()
      return args.id == null ? 'Marked all feed items read.' : `Marked feed item ${String(args.id)} read.`
    }
    case 'feed_hide_item': {
      setFeedItemState(String(args.id), { is_hidden: true })
      ctx.notifyFeedChanged()
      return `Hid feed item ${String(args.id)}.`
    }
    case 'app_launch':
      return ctx.apps.launch(String(args.name))
    case 'app_status':
      return ctx.apps.statusText()
    case 'app_logs':
      return ctx.apps.logs(String(args.name), args.tail_chars == null ? undefined : Number(args.tail_chars))
    case 'app_open_ui': {
      const url = ctx.apps.uiUrlFor(String(args.name))
      if (!url) return `Error: app "${String(args.name)}" is not running or has no ui_url configured.`
      ctx.browser.setVisible(true)
      await ctx.browser.navigate(url)
      await new Promise((r) => setTimeout(r, 1200))
      return `Opened ${url} in the embedded browser. Use browser_snapshot to see its interactive elements.`
    }
    case 'app_stop':
      return ctx.apps.stop(String(args.name))
    case 'desktop_launch':
      return ctx.desktop.launch(String(args.name))
    case 'desktop_screenshot':
      return ctx.desktop.screenshot(String(args.name))
    case 'desktop_click':
      return ctx.desktop.click(String(args.name), Number(args.x), Number(args.y), args.button === 'right' ? 'right' : 'left', Boolean(args.double_click))
    case 'desktop_type':
      return ctx.desktop.type(String(args.name), String(args.text), Boolean(args.submit))
    case 'desktop_key':
      return ctx.desktop.key(String(args.name), String(args.keys))
    case 'desktop_status':
      return ctx.desktop.statusText()
    case 'desktop_stop':
      return ctx.desktop.stop(String(args.name))
    case 'shell_exec':
      return ctx.shell.exec(ctx.sessionId, String(args.command), args.timeout_seconds == null ? undefined : Number(args.timeout_seconds) * 1000)
    case 'shell_bg_start': {
      const id = ctx.shell.bgStart(ctx.sessionId, String(args.command))
      return `Started background process [${id}]. Use shell_bg_wait with a pattern (e.g. "listening|error") or shell_bg_output to follow it.`
    }
    case 'shell_bg_output':
      return ctx.shell.bgOutput(String(args.id), args.tail_chars == null ? undefined : Number(args.tail_chars))
    case 'shell_bg_wait':
      return ctx.shell.bgWait(String(args.id), String(args.pattern), args.timeout_seconds == null ? undefined : Number(args.timeout_seconds) * 1000)
    case 'shell_bg_kill':
      return ctx.shell.bgKill(String(args.id))
    case 'shell_bg_list':
      return ctx.shell.bgList(ctx.sessionId)
    case 'mtg_search': {
      const r = await mtg.smartSearch(String(args.query ?? ''))
      if (!r.cards.length) return `No cards matched "${String(args.query)}". Try just the card name, or add the set name.`
      const limit = args.limit == null ? 20 : Math.max(1, Number(args.limit))
      const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
      const lines = r.cards.slice(0, limit).map((c) => {
        const finishes = (c.finishes?.length ? c.finishes : ['nonfoil'])
          .map((f) => `${f} ${money(mtg.priceOf(c, f))}`).join(' · ')
        return `- ${c.name} [${c.set.toUpperCase()} #${c.collector_number}] ${c.rarity}\n    scryfall id: ${c.id}\n    ${finishes}`
      })
      const head = r.rewritten ? `${r.note}\n` : ''
      const more = r.cards.length > limit ? `\n(${r.cards.length - limit} more printings not shown)` : ''
      return `${head}${lines.join('\n')}${more}`
    }
    case 'mtg_search_sealed': {
      const r = await mtg.searchSealed(String(args.query ?? ''))
      if (!r.products.length) return r.note ?? `No sealed product matched "${String(args.query)}".`
      const lines = r.products.slice(0, 30).map((p) =>
        `- ${p.name}\n    ${p.set_code.toUpperCase()} · ${p.category ?? '?'}${p.subtype ? `/${p.subtype}` : ''}${p.release_date ? ` · ${p.release_date}` : ''}\n    tcgplayer product id: ${p.tcgplayer_product_id ?? 'NONE (cannot be auto-priced)'}`)
      return `${r.note ? `${r.note}\n` : ''}${lines.join('\n')}`
    }
    case 'mtg_upcoming_sets': {
      const sets = mtg.upcomingSets(args.ahead_days == null ? undefined : Number(args.ahead_days))
      if (!sets.length) return 'No upcoming sets cached. The set list syncs every 12h; ask the user to hit "Sync sets" on the Magic page if this looks wrong.'
      const today = new Date(); today.setHours(0, 0, 0, 0)
      return sets.map((s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.released_at ?? '')
        const days = m ? Math.round((new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() - today.getTime()) / 86_400_000) : null
        return `- ${s.released_at ?? 'TBA'} (${days == null ? '?' : days === 0 ? 'today' : `in ${days}d`}) ${s.name} [${s.code.toUpperCase()}] · ${s.set_type ?? '?'}`
      }).join('\n')
    }
    case 'mtg_ev_board': {
      if (args.scan) await ev.scan({})
      let rows = ev.board()
      if (args.positive_only) rows = rows.filter((r) => (r.net_pct ?? -1) > 0)
      if (args.kind) rows = rows.filter((r) => r.kind === args.kind)
      if (!rows.length) {
        return ev.board().length
          ? 'Nothing on the EV board matches that filter.'
          : 'The EV board is empty. Ask to scan (scan:true), or hit Scan on the Magic page EV tab.'
      }
      const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
      const limit = args.limit == null ? 20 : Math.max(1, Number(args.limit))
      const lines = rows.slice(0, limit).map((r) => {
        const head = `${r.net_pct == null ? '  —' : `${r.net_pct > 0 ? '+' : ''}${r.net_pct}%`} ${r.name} [${r.set_code.toUpperCase()}] ${r.kind}`
        const body =
          r.method === 'simulated'
            ? `      costs ${money(r.price)} · EV mean ${money(r.ev_mean)}, MEDIAN ${money(r.ev_median)} · ${r.packs} pack(s)` +
              (r.chance_of_profit != null ? ` · ${Math.round(r.chance_of_profit * 100)}% of units beat the price` : '')
            : `      costs ${money(r.price)} · contents ${money(r.ev_mean)} exactly · ${money(r.ev_liquid)} counting only cards over $2`
        return `${head}\n${body}${r.note ? `\n      ${r.note}` : ''}`
      })
      return [
        'EV board (retail asks; a buylist realises roughly half, and bulk counts at face value):',
        ...lines,
        'On simulated rows the mean is dragged up by rare chase cards — if the median is below the price, the typical unit loses money.'
      ].join('\n')
    }
    case 'mtg_sealed_contents': {
      const c = await mtg.sealedContents(String(args.uuid))
      if (!c) return 'No sealed product with that uuid is catalogued. Run mtg_search_sealed first.'
      const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
      if (!c.cards.length) return `${c.name}: ${c.note ?? 'no determined contents.'}`
      const lines = [
        `${c.name} [${c.setCode.toUpperCase()}]`,
        `- ${c.cardCount} cards (${c.cards.length} distinct, ${c.pricedCount} priced)`,
        `- Singles at retail ask: ${money(c.singlesTotal)}`,
        `- Sealed market price: ${money(c.sealedPrice)}`,
        c.netGain == null
          ? '- No sealed price available, so no comparison.'
          : `- Net: ${money(c.netGain)} (${c.netGainPct}%) ${c.netGain >= 0 ? 'in favour of cracking it' : 'in favour of keeping it sealed'}`,
        c.estimatedFinishCount
          ? `- CAUTION: ${c.estimatedFinishCount} card(s) have no quote for the finish this product contains, so the other finish stood in.`
          : '',
        c.randomComponents.length ? `- Not counted (random): ${c.randomComponents.join(', ')}` : '',
        '- Prices are retail asks; a buylist realises roughly half, and bulk commons are counted at face value.',
        'Top cards:'
      ].filter(Boolean)
      const limit = args.limit == null ? 15 : Math.max(1, Number(args.limit))
      for (const x of c.cards.slice(0, limit)) {
        lines.push(`    ${money(x.lineTotal)}  ${x.count}x ${x.name} [${x.setCode.toUpperCase()} #${x.collectorNumber}] ${x.foil ? 'foil' : 'nonfoil'} @ ${money(x.unitPrice)}`)
      }
      return lines.join('\n')
    }
    case 'mtg_upcoming_secret_lairs': {
      if (args.refresh) await secretlair.syncUpcoming()
      const drops = secretlair.upcomingByDrop()
      if (!drops.length) return 'No Secret Lair drops are currently announced. The list syncs twice a day from the upstream announcement feed.'
      const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
      return drops
        .map((d) => {
          const head = `${d.dropName} — on sale ${d.releaseDate ?? 'TBA'} · ${d.items.length} lair(s) · $${d.msrpTotal.toFixed(2)} for one of each`
          const items = d.items
            .map((i) => `    - ${i.name} ${money(i.msrp)}${i.foil ? ' (foil)' : ''}${i.randomized ? ' (randomised pack)' : ''}`)
            .join('\n')
          return `${head}\n${items}`
        })
        .join('\n')
    }
    case 'mtg_watchlist': {
      const rows = listMtgWatchlist()
      if (!rows.length) return 'The Magic watchlist is empty.'
      const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
      return rows.map((w) =>
        `- ${w.id}: ${w.name} [${w.set_code?.toUpperCase() ?? '?'}${w.collector_number ? ` #${w.collector_number}` : ''}] ${w.variant} (${w.kind})\n    last ${money(w.last_price)} · target ${money(w.target_price)} · alerts ${w.alert_enabled ? 'on' : 'off'} · ${w.ext_source}:${w.ext_id ?? '—'}`
      ).join('\n')
    }
    case 'mtg_owned': {
      const all = listMtgOwned()
      if (!all.length) return 'No Magic cards or sealed products owned yet (nothing in the Vault carries a price feed).'
      const minPrice = args.min_price == null || !Number.isFinite(Number(args.min_price)) ? null : Number(args.min_price)
      const kind = String(args.kind ?? 'all')
      let rows = all.filter((o) =>
        (kind === 'card' ? o.ext_source === 'scryfall' : kind === 'sealed' ? o.ext_source === 'tcgplayer' : true) &&
        (minPrice == null || (o.last_price != null && o.last_price >= minPrice))
      )
      const limit = Number(args.limit)
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, Math.floor(limit))
      if (!rows.length) return `None of the ${all.length} holding(s) match${minPrice != null ? ` a unit price of at least $${minPrice.toFixed(2)}` : ''}${kind !== 'all' ? ` (kind ${kind})` : ''}.`
      const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
      if (args.summary === true) {
        const worth = (list: typeof rows) => list.reduce((n, o) => n + (o.last_price ?? 0) * o.quantity, 0)
        const cards = rows.filter((o) => o.ext_source === 'scryfall')
        const sealed = rows.filter((o) => o.ext_source === 'tcgplayer')
        const unpriced = rows.filter((o) => o.last_price == null).length
        const top = rows.slice(0, 10).map((o) => `- ${o.name} [${o.maker ?? o.category}] ${o.variant ?? ''} — ${o.quantity > 1 ? `${o.quantity} × ${money(o.last_price)} = ${money((o.last_price ?? 0) * o.quantity)}` : money(o.last_price)}`)
        return [
          `Collection value at last quote: ${money(worth(rows))} across ${rows.length} holding(s), ${rows.reduce((n, o) => n + o.quantity, 0)} copies.`,
          `Cards: ${money(worth(cards))} (${cards.length} holdings) · Sealed: ${money(worth(sealed))} (${sealed.length} holdings)${unpriced ? ` · ${unpriced} holding(s) have no price yet and count as $0` : ''}.`,
          '',
          'Most valuable holdings:',
          ...top
        ].join('\n')
      }
      let total = 0
      const lines = rows.map((o) => {
        const line = (o.last_price ?? 0) * o.quantity
        total += line
        // Price first and quantity spelled out as arithmetic: small models
        // re-transcribing a long list otherwise confuse unit and line values.
        const priced = o.quantity > 1 ? `${o.quantity} × ${money(o.last_price)} = ${money(line)}` : money(o.last_price)
        return `- ${o.name} [${o.maker ?? o.category}] ${o.variant ?? ''} — ${priced}\n    paid ${money(o.purchase_price)} · ${o.points} day(s) of history · vault:${o.id} · ${o.ext_source}:${o.ext_id}`
      })
      const copies = rows.reduce((n, o) => n + o.quantity, 0)
      const scope = rows.length === all.length ? `${rows.length} holding(s)` : `${rows.length} of ${all.length} holding(s) (filtered)`
      return `${lines.join('\n')}\n\nTotal at last quote: $${total.toFixed(2)} across ${scope}, ${copies} cop${copies === 1 ? 'y' : 'ies'} in all. Each line above is a distinct printing, even when names repeat.`
    }
    case 'db_schema':
      return schemaText(args.filter == null ? undefined : String(args.filter))
    case 'db_query':
      return runQuery(String(args.sql ?? ''))
    case 'mtg_watch_add': {
      const name = String(args.name ?? '').trim()
      const extSource = String(args.ext_source ?? '').trim()
      const extId = String(args.ext_id ?? '').trim()
      if (!name) return 'Error: name is required.'
      if (extSource !== 'scryfall' && extSource !== 'tcgplayer') return 'Error: ext_source must be "scryfall" (cards) or "tcgplayer" (sealed).'
      if (!extId) return 'Error: ext_id is required — get it from mtg_search (scryfall id) or mtg_search_sealed (tcgplayer product id).'
      const kind = args.kind == null ? (extSource === 'tcgplayer' ? 'sealed' : 'card') : String(args.kind)
      const w = createMtgWatch({
        kind,
        name,
        set_code: args.set_code == null ? null : String(args.set_code),
        collector_number: args.collector_number == null ? null : String(args.collector_number),
        ext_source: extSource,
        ext_id: extId,
        variant: args.variant == null ? (kind === 'sealed' ? 'sealed' : 'nonfoil') : String(args.variant),
        target_price: args.target_price == null ? null : Number(args.target_price),
        notes: args.notes == null ? null : String(args.notes)
      })
      ctx.notifyMtgChanged()
      return `Watching "${w.name}" (${w.variant}, ${w.ext_source}) — id ${w.id}.${w.target_price != null ? ` Alert at or below $${w.target_price.toFixed(2)}.` : ' No target price set, so no alerts yet.'} Run mtg_refresh_prices to take its first quote.`
    }
    case 'mtg_watch_update': {
      const w = getMtgWatch(String(args.id))
      if (!w) return `Error: no watchlist entry with id ${String(args.id)}. Use mtg_watchlist to find it.`
      const patch: Record<string, unknown> = {}
      if (args.target_price != null) patch.target_price = Number(args.target_price)
      if (args.alert_enabled != null) patch.alert_enabled = args.alert_enabled ? 1 : 0
      if (args.notes != null) patch.notes = String(args.notes)
      if (!Object.keys(patch).length) return 'Nothing to change — pass target_price, alert_enabled, or notes.'
      updateMtgWatch(w.id, patch)
      ctx.notifyMtgChanged()
      return `Updated "${w.name}".`
    }
    case 'mtg_watch_remove': {
      const w = getMtgWatch(String(args.id))
      if (!w) return `Error: no watchlist entry with id ${String(args.id)}.`
      deleteMtgWatch(w.id)
      ctx.notifyMtgChanged()
      return `Removed "${w.name}" from the watchlist. Its price history is kept.`
    }
    case 'mtg_price_history': {
      const rows = listMtgPrices(String(args.ext_id), String(args.variant), args.days == null ? 60 : Number(args.days))
      if (!rows.length) return 'No price history for that id/variant yet. It builds one point per day from when the item was first tracked.'
      const first = rows[rows.length - 1]
      const last = rows[0]
      const delta = last.price - first.price
      const pct = first.price > 0 ? (delta / first.price) * 100 : 0
      const series = rows.map((r) => `  ${r.observed_on}  $${r.price.toFixed(2)}`).join('\n')
      return [
        `${rows.length} point(s), ${first.observed_on} → ${last.observed_on} (${last.source})`,
        `$${first.price.toFixed(2)} → $${last.price.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}, ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`,
        series
      ].join('\n')
    }
    case 'mtg_refresh_prices': {
      const r = await mtg.refreshPrices()
      ctx.notifyMtgChanged()
      ctx.notifyVaultChanged()
      if (!r.checked) return 'Nothing is tracked yet — add something with mtg_watch_add first.'
      const errs = r.errors.length ? `\nProblems:\n${r.errors.map((e) => `  - ${e}`).join('\n')}` : ''
      return `Priced ${r.priced}/${r.checked} tracked item(s).${r.alerts ? ` ${r.alerts} target-price alert(s) fired.` : ''}${errs}`
    }
    case 'mtg_backfill_history': {
      const r = await mtg.backfillHistory()
      ctx.notifyMtgChanged()
      ctx.notifyVaultChanged()
      const errs = r.errors.length ? `
Problems: ${r.errors.join('; ')}` : ''
      if (!r.cards) return 'Nothing tracked yet — add cards with mtg_watch_add first.'
      return `Backfilled ${r.points} price point(s) for ${r.matched}/${r.cards} tracked card(s). Streamed ${r.megabytes}MB in ${Math.round(r.seconds)}s.${errs}`
    }
    case 'mtg_track_sealed_set': {
      const list = mtg.followSealedSet(String(args.set_code), args.follow !== false)
      ctx.notifyMtgChanged()
      const code = String(args.set_code).toLowerCase()
      return list.includes(code)
        ? `Now tracking every sealed product in ${code.toUpperCase()} daily. Followed sets: ${list.map((c) => c.toUpperCase()).join(', ')}`
        : `Stopped tracking sealed for ${code.toUpperCase()}. Followed sets: ${list.length ? list.map((c) => c.toUpperCase()).join(', ') : 'none'}`
    }
    case 'mtg_sealed_prices': {
      const days = args.days == null ? 60 : Number(args.days)
      const since = new Date(Date.now() - days * 86_400_000)
      const p = (n: number): string => String(n).padStart(2, '0')
      const rows = sealedPriceSnapshot(String(args.set_code),
        `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`)
      if (!rows.length) return `No sealed products catalogued for ${String(args.set_code).toUpperCase()} — run mtg_search_sealed for that set once to pull its catalogue.`
      const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`)
      return rows.map((r) => {
        const change = r.latest != null && r.earliest != null && r.earliest > 0 && r.latestOn !== r.earliestOn
          ? `${((r.latest - r.earliest) / r.earliest) * 100 >= 0 ? '+' : ''}${((((r.latest - r.earliest) / r.earliest) * 100)).toFixed(1)}%`
          : ''
        return `- ${money(r.latest).padStart(9)} ${change.padStart(7)}  ${r.name}${r.points ? `  (${r.points}d history)` : '  (no history yet)'}`
      }).join('\n')
    }
    case 'mtg_pack_ev': {
      const r = await mtg.packEv(
        String(args.query ?? ''),
        args.booster_type === 'play' ? 'play' : 'collector',
        20_000,
        args.pack_price == null ? null : Number(args.pack_price)
      )
      if (r.note) return r.note
      const money = (n: number) => `$${n.toFixed(2)}`
      const hits = r.topHits.slice(0, 8).map((h) =>
        `   ${money(h.price).padStart(9)} ${h.finish.padEnd(8)} ${(100 * h.chancePerPack).toFixed(2)}%/pack  ${h.name} [${h.setCode.toUpperCase()} #${h.collectorNumber}]`)
      return [
        `${r.sets.map((s) => s.code.toUpperCase()).join('+')} · ${r.booster} · ${r.simulations.toLocaleString()} simulations`,
        `Mean ${money(r.mean)} · MEDIAN ${money(r.median)} · p10 ${money(r.p10)} · p90 ${money(r.p90)}`,
        `Counting only cards >= $${r.liquidThreshold}: mean ${money(r.meanLiquid)}, median ${money(r.medianLiquid)}`,
        r.packPrice != null
          ? `At ${money(r.packPrice)} a pack, ${(100 * (r.chanceOfProfit ?? 0)).toFixed(1)}% of packs beat their cost.`
          : 'No pack price supplied, so no profit chance computed.',
        r.unpricedChase ? `${r.unpricedChase} unpriced chase card(s) excluded — the real ceiling is higher than this.` : '',
        '',
        'Biggest contributors:',
        ...hits
      ].filter(Boolean).join('\n')
    }
    case 'mtg_set_value': {
      const v = await mtg.valueSet(String(args.query ?? ''), Boolean(args.force))
      if (v.note) return v.note
      if (!v.cardCount) return `No cards found for "${String(args.query)}".`
      const limit = args.limit == null ? 15 : Math.max(1, Number(args.limit))
      const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`)
      const lines = v.cards.slice(0, limit).map((c, i) => {
        const finishes = Object.entries(c.prices).map(([f, p]) => `${f} ${money(p)}`).join(' · ')
        return `${String(i + 1).padStart(2)}. ${money(c.bestPrice)} (${c.bestFinish ?? '—'})  ${c.name} [${c.setCode.toUpperCase()} #${c.collectorNumber}] ${c.rarity}\n      ${finishes}`
      })
      return [
        `${v.sets.map((s) => `${s.name} [${s.code.toUpperCase()}]`).join(' + ')}`,
        `${v.cardCount} printings, ${v.pricedCount} priced.`,
        `Complete the set (cheapest finish of each): $${v.totalCheapest.toLocaleString()}`,
        `One premium copy of everything (best finish): $${v.totalBest.toLocaleString()}`,
        '',
        `Top ${Math.min(limit, v.cards.length)} by value:`,
        ...lines
      ].join('\n')
    }
    case 'mtg_find_retailers': {
      const r = await retail.discoverForWatch(String(args.watch_id))
      ctx.notifyMtgChanged()
      const rows = listMtgListings({ watchId: String(args.watch_id) })
      const body = rows.map((l) =>
        `- ${l.retailer} [${l.kind}] ${l.status}${l.price != null ? ` $${l.price.toFixed(2)}` : ''}\n    ${l.url}`).join('\n')
      return `${r.note}\n\n${body}`
    }
    case 'mtg_retailers': {
      const rows = listMtgListings({ watchId: String(args.watch_id) })
      if (!rows.length) return 'No buy links known yet — run mtg_find_retailers first.'
      return rows.map((l) =>
        `- ${l.retailer} [${l.kind}] ${l.status}${l.price != null ? ` $${l.price.toFixed(2)}` : ''}${l.last_checked_at ? ` · checked ${new Date(l.last_checked_at).toLocaleString()}` : ''}${l.last_error ? ` · ${l.last_error}` : ''}\n    ${l.url}`).join('\n')
    }
    case 'mtg_add_retailer_link': {
      try {
        const l = await retail.addManualListing(String(args.watch_id), String(args.url))
        ctx.notifyMtgChanged()
        return `Linked ${l.retailer}: ${l.url}${l.price != null ? ` — $${l.price.toFixed(2)}, ${l.status}` : ` — ${l.status}`}`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    case 'mtg_refresh_stock': {
      const r = await retail.refreshListings()
      ctx.notifyMtgChanged()
      if (!r.checked) return 'No resolved buy links to check. Run mtg_find_retailers on a watchlist entry first.'
      const moves = r.transitions.length
        ? `\nChanges:\n${r.transitions.map((t) => `  - ${t.name} at ${t.retailer}: ${t.from} -> ${t.to}\n    ${t.url}`).join('\n')}`
        : '\nNo status changes.'
      const errs = r.errors.length ? `\nProblems: ${r.errors.join('; ')}` : ''
      return `Checked ${r.checked} link(s), ${r.changed} changed.${moves}${errs}`
    }
    case 'vault_list_items': {
      const rows = listVaultItems(args.category == null ? undefined : String(args.category).toLowerCase())
      if (!rows.length) return 'The Vault is empty — no collectibles cataloged yet.'
      const latest = latestVaultValuations()
      const money = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`)
      return rows.map((it) => {
        const l = latest[it.id] ?? {}
        const parts = [
          `[${it.category}]`, it.year ?? '', it.name, it.grade ? `(${it.grade})` : '',
          it.quantity > 1 ? `×${it.quantity}` : '',
          it.metal && it.metal_weight_ozt ? `${it.metal_weight_ozt} ozt ${it.metal}/ea` : ''
        ].filter(Boolean).join(' ')
        const marketVal = l.market ?? l.manual
        return `- ${it.id}: ${parts}\n    paid ${money(it.purchase_price)} · melt ${money(l.melt?.value_mid)} · market ${money(marketVal?.value_mid)}${marketVal ? ` (${new Date(marketVal.created_at).toLocaleDateString()})` : ''}`
      }).join('\n')
    }
    case 'vault_get_item': {
      const it = getVaultItem(String(args.id))
      if (!it) return `Error: no Vault item with id ${String(args.id)}.`
      const vals = listVaultValuations(it.id)
      const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
      const history = vals.length
        ? vals.map((v) => `  - ${new Date(v.created_at).toLocaleDateString()} [${v.kind}] mid ${money(v.value_mid)}${v.value_low != null || v.value_high != null ? ` (${money(v.value_low)}–${money(v.value_high)})` : ''}${v.source ? ` — ${v.source}` : ''}${v.notes ? `\n    ${v.notes}` : ''}`).join('\n')
        : '  (none yet)'
      return [
        `id: ${it.id}`,
        `name: ${it.name}`,
        `category: ${it.category}`,
        `year: ${it.year ?? '—'} · maker: ${it.maker ?? '—'} · grade: ${it.grade ?? '—'} · quantity: ${it.quantity}`,
        `metal: ${it.metal ?? 'none'}${it.metal_weight_ozt ? ` @ ${it.metal_weight_ozt} ozt/ea` : ''}`,
        `purchase: ${money(it.purchase_price)}${it.purchase_date ? ` on ${it.purchase_date}` : ''}`,
        `notes: ${it.notes ?? '—'}`,
        `photos: ${it.photos.length}`,
        `valuation history:`,
        history
      ].join('\n')
    }
    case 'vault_add_item': {
      if (!args.name || !String(args.name).trim()) return 'Error: item name is required.'
      const item = createVaultItem({
        name: String(args.name),
        category: args.category == null ? undefined : String(args.category),
        year: args.year == null ? null : String(args.year),
        maker: args.maker == null ? null : String(args.maker),
        grade: args.grade == null ? null : String(args.grade),
        quantity: args.quantity == null ? 1 : Number(args.quantity),
        metal: args.metal == null ? null : String(args.metal),
        metal_weight_ozt: args.metal_weight_ozt == null ? null : Number(args.metal_weight_ozt),
        purchase_price: args.purchase_price == null ? null : Number(args.purchase_price),
        purchase_date: args.purchase_date == null ? null : String(args.purchase_date),
        notes: args.notes == null ? null : String(args.notes)
      })
      ctx.notifyVaultChanged()
      return `Added "${item.name}" to the Vault (id ${item.id}).${item.metal && item.metal_weight_ozt ? ' Melt value will be computed from spot prices.' : ''}`
    }
    case 'vault_update_item': {
      const it = getVaultItem(String(args.id))
      if (!it) return `Error: no Vault item with id ${String(args.id)}.`
      updateVaultItem(it.id, (args.patch ?? {}) as Partial<VaultItem>)
      ctx.notifyVaultChanged()
      return `Updated Vault item ${it.id} ("${it.name}").`
    }
    case 'vault_spot_prices': {
      const r = await vault.refreshMelt()
      const spots = await vault.spotPrices()
      ctx.notifyVaultChanged()
      const lines = Object.entries(spots.usdPerOzt).map(([m, p]) => `- ${m}: $${p!.toFixed(2)}/ozt`)
      const errs = spots.errors.length ? `\nUnavailable: ${spots.errors.join('; ')}` : ''
      return `Spot prices (fetched ${new Date(spots.fetchedAt).toLocaleTimeString()}):\n${lines.join('\n')}\nMelt refreshed for ${r.updated} item(s), ${r.skipped} without metal content.${errs}`
    }
    case 'vault_record_valuation': {
      const it = getVaultItem(String(args.item_id))
      if (!it) return `Error: no Vault item with id ${String(args.item_id)}. Use vault_list_items to find the right id.`
      if (args.value_mid == null || !Number.isFinite(Number(args.value_mid))) return 'Error: value_mid (USD) is required.'
      const v = addVaultValuation({
        item_id: it.id,
        kind: 'market',
        value_mid: Number(args.value_mid),
        value_low: args.value_low == null ? null : Number(args.value_low),
        value_high: args.value_high == null ? null : Number(args.value_high),
        source: args.source == null ? null : String(args.source),
        notes: args.notes == null ? null : String(args.notes)
      })
      ctx.notifyVaultChanged()
      return `Recorded market valuation for "${it.name}": $${v.value_mid.toFixed(2)}${v.value_low != null && v.value_high != null ? ` (range $${v.value_low.toFixed(2)}–$${v.value_high.toFixed(2)})` : ''}.`
    }
    case 'memory_save': {
      const text = String(args.text ?? '').trim()
      if (!text) return 'Error: memory text is empty.'
      const m = addMemory({ text, category: args.category == null ? undefined : String(args.category), session_id: ctx.sessionId })
      return `Saved memory ${m.id.slice(0, 8)} [${m.category}].`
    }
    case 'memory_search': {
      const rows = searchMemories(String(args.query ?? ''), args.limit == null ? 12 : Number(args.limit))
      if (!rows.length) return 'No matching memories.'
      return rows.map((m) => `- ${m.id.slice(0, 8)} [${m.category}] ${m.text}`).join('\n')
    }
    case 'memory_list': {
      const rows = listMemories(args.category == null ? undefined : String(args.category), args.limit == null ? 50 : Number(args.limit))
      if (!rows.length) return 'No memories stored yet.'
      return rows.map((m) => `- ${m.id.slice(0, 8)} [${m.category}] ${m.text}`).join('\n')
    }
    case 'memory_update': {
      const id = resolveMemoryId(String(args.id ?? ''))
      if (typeof id !== 'string') return id.error
      updateMemory(id, String(args.text), args.category == null ? undefined : String(args.category))
      return `Updated memory ${id.slice(0, 8)}.`
    }
    case 'memory_delete': {
      const id = resolveMemoryId(String(args.id ?? ''))
      if (typeof id !== 'string') return id.error
      deleteMemory(id)
      return `Deleted memory ${id.slice(0, 8)}.`
    }
    case 'skill_read':
      try {
        return await readSkill(String(args.name))
      } catch {
        return `Error: no skill named "${String(args.name)}" — check the skills list in your prompt.`
      }
    case 'skill_save': {
      const file = await saveSkill({
        name: String(args.name),
        description: String(args.description ?? ''),
        when_to_use: args.when_to_use == null ? undefined : String(args.when_to_use),
        body: String(args.body ?? '')
      })
      return `Saved skill to ${file}. It will be listed in future agent prompts.`
    }
    default:
      return `Unknown tool: ${name}`
  }
}

/** Resolve a full or prefixed memory id; error string when missing/ambiguous. */
function resolveMemoryId(prefix: string): string | { error: string } {
  if (!prefix) return { error: 'Error: memory id required.' }
  const matches = listMemories(undefined, 1000).filter((m) => m.id.startsWith(prefix))
  if (!matches.length) return { error: `Error: no memory with id ${prefix}.` }
  if (matches.length > 1) return { error: `Error: id prefix ${prefix} is ambiguous (${matches.length} matches).` }
  return matches[0].id
}
