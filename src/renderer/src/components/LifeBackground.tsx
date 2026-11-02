import { useEffect, useRef } from 'react'

const CELL_SIZE = 14
const STEP_MS = 140
const LIVE_ALPHA = 0.105
const TRAIL_ALPHA = 0.13
const INITIAL_DENSITY = 0.18

export default function LifeBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reduceMotion.matches) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let width = 0
    let height = 0
    let cols = 0
    let rows = 0
    let cells = new Uint8Array(0)
    let next = new Uint8Array(0)
    let raf = 0
    let lastStep = 0
    let running = true

    const index = (x: number, y: number) => y * cols + x

    const seed = () => {
      for (let i = 0; i < cells.length; i += 1) {
        cells[i] = Math.random() < INITIAL_DENSITY ? 1 : 0
      }
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      cols = Math.max(8, Math.ceil(width / CELL_SIZE))
      rows = Math.max(8, Math.ceil(height / CELL_SIZE))
      cells = new Uint8Array(cols * rows)
      next = new Uint8Array(cols * rows)
      seed()
      ctx.clearRect(0, 0, width, height)
    }

    const step = () => {
      let liveCount = 0

      for (let y = 0; y < rows; y += 1) {
        const yUp = y === 0 ? rows - 1 : y - 1
        const yDown = y === rows - 1 ? 0 : y + 1

        for (let x = 0; x < cols; x += 1) {
          const xLeft = x === 0 ? cols - 1 : x - 1
          const xRight = x === cols - 1 ? 0 : x + 1

          const neighbors =
            cells[index(xLeft, yUp)] +
            cells[index(x, yUp)] +
            cells[index(xRight, yUp)] +
            cells[index(xLeft, y)] +
            cells[index(xRight, y)] +
            cells[index(xLeft, yDown)] +
            cells[index(x, yDown)] +
            cells[index(xRight, yDown)]

          const alive = cells[index(x, y)] === 1
          const willLive = alive ? neighbors === 2 || neighbors === 3 : neighbors === 3
          next[index(x, y)] = willLive ? 1 : 0
          if (willLive) liveCount += 1
        }
      }

      const swap = cells
      cells = next
      next = swap

      if (liveCount < cells.length * 0.025 || liveCount > cells.length * 0.48) {
        seed()
      }
    }

    const render = () => {
      ctx.fillStyle = `rgba(7, 9, 13, ${TRAIL_ALPHA})`
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = `rgba(34, 211, 238, ${LIVE_ALPHA})`

      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          if (cells[index(x, y)]) {
            ctx.fillRect(x * CELL_SIZE + 1, y * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2)
          }
        }
      }
    }

    const animate = (time: number) => {
      if (!running) return
      if (time - lastStep >= STEP_MS) {
        step()
        render()
        lastStep = time
      }
      raf = window.requestAnimationFrame(animate)
    }

    const handleVisibility = () => {
      running = document.visibilityState === 'visible'
      if (running) {
        lastStep = performance.now()
        raf = window.requestAnimationFrame(animate)
      } else {
        window.cancelAnimationFrame(raf)
      }
    }

    resize()
    render()
    raf = window.requestAnimationFrame(animate)
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      running = false
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  return <canvas aria-hidden="true" ref={canvasRef} className="life-background" />
}
