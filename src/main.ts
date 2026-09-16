import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const MINUTE_MS = 60_000
const DEFAULT_MINUTES = 30
const MIN_MINUTES = 1
const MAX_MINUTES = 60
const MAIN_VISIBLE_MS = 5_000
const ANIMATION_FRAME_MS = 500
const COMPLETION_DURATION_MS = 3_000
const SCROLL_DEDUPLICATION_MS = 250
const STORAGE_KEY = 'even-g2-fuel-timer.settings.v1'
const EXIT_IMMEDIATELY = 0
const MAIN_HELP_TEXT = '・start/pause; ・・exit; swipe to change timer length'
const EXIT_CONFIRMATION_TEXT = 'Exit Fuel Timer?\n・・confirm; ・cancel'
// Protobuf omits an empty string, so use a visible-field/no-glyph payload to
// ensure the device actually replaces the existing help text.
const HIDDEN_HELP_TEXT = ' '

const MAIN_VISUAL = { id: 1, name: 'main-visual', x: 8, y: 72, width: 280, height: 144 }
const MAIN_TIMER = { id: 2, name: 'main-timer', x: 304, y: 72, width: 256, height: 144 }
const COMPACT = { id: 3, name: 'compact', x: 408, y: 8, width: 160, height: 64 }
const HELP = { id: 4, name: 'event-help', x: 8, y: 220, width: 560, height: 56 }
const MUG_ASSET_URL = new URL('./assets/beer-mug-pictogram.png', import.meta.url).href
const FUEL_UP_ASSET_URL = new URL('./assets/fuel-up-logotype.png', import.meta.url).href

type TimerMode = 'idle' | 'running' | 'paused' | 'completed'
type ViewMode = 'main' | 'compact'
type ImageSpec = typeof MAIN_VISUAL

interface TimerState {
  mode: TimerMode
  view: ViewMode
  configuredMinutes: number
  remainingMs: number
  deadlineMs: number | null
  animationFrame: number
}

interface StoredSettings {
  minutes: number
}

const bridge = await waitForEvenAppBridge()
const state: TimerState = {
  mode: 'idle',
  view: 'main',
  configuredMinutes: loadConfiguredMinutes(),
  remainingMs: 0,
  deadlineMs: null,
  animationFrame: 0,
}
state.remainingMs = state.configuredMinutes * MINUTE_MS

let disposed = false
let isForeground = true
let renderRevision = 0
let imageQueue: Promise<void> = Promise.resolve()
let countdownTimer: number | null = null
let compactTimer: number | null = null
let animationTimer: number | null = null
let completionTimers: number[] = []
let displayErrorShown = false
let exitConfirmationArmed = false
let exitRequestPending = false
let lastScrollAt = 0
let lastScrollDirection: 1 | -1 | null = null
const imageCache = new Map<string, Promise<Uint8Array>>()
const imageRevisions = new Map<number, number>()
const mugImage = loadImage(MUG_ASSET_URL)
const fuelUpImage = loadImage(FUEL_UP_ASSET_URL)

const startupResult = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 4,
    imageObject: [imageContainer(MAIN_VISUAL), imageContainer(MAIN_TIMER), imageContainer(COMPACT)],
    textObject: [
      new TextContainerProperty({
        xPosition: HELP.x,
        yPosition: HELP.y,
        width: HELP.width,
        height: HELP.height,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 2,
        containerID: HELP.id,
        containerName: HELP.name,
        content: '',
        isEventCapture: 1,
      }),
    ],
  }),
)

if (startupResult !== 0) throw new Error(`Failed to create startup page (${startupResult})`)

await renderCurrentView()

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
    unsubscribe()
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    isForeground = false
    stopAnimation()
    clearCountdownTimer()
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    isForeground = true
    void reconcileAfterForeground()
    return
  }

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT
    || textType === OsEventTypeList.DOUBLE_CLICK_EVENT
    || listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    void handleDoubleClick()
    return
  }

  const scrollType = [textType, listType, sysType].find(type => (
    type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT
  )) ?? null

  if (scrollType !== null) {
    const direction = scrollType === OsEventTypeList.SCROLL_TOP_EVENT ? 1 : -1
    if (!isDuplicateScroll(direction)) void handleScroll(direction)
    return
  }

  if (
    sysType === OsEventTypeList.CLICK_EVENT
    || textType === OsEventTypeList.CLICK_EVENT
    || listType === OsEventTypeList.CLICK_EVENT
  ) {
    void handleSingleClick()
  }
})

function imageContainer(spec: ImageSpec): ImageContainerProperty {
  return new ImageContainerProperty({
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.width,
    height: spec.height,
    containerID: spec.id,
    containerName: spec.name,
  })
}

// CLICK_EVENT is zero and protobuf may omit zero-valued fields. Only default
// eventType after confirming that the corresponding event envelope exists.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function isDuplicateScroll(direction: 1 | -1): boolean {
  const now = performance.now()
  const duplicate = direction === lastScrollDirection && now - lastScrollAt < SCROLL_DEDUPLICATION_MS
  lastScrollDirection = direction
  lastScrollAt = now
  return duplicate
}

async function handleDoubleClick(): Promise<void> {
  if (disposed || exitRequestPending) return

  if (!exitConfirmationArmed) {
    exitConfirmationArmed = true
    await setHelpText(EXIT_CONFIRMATION_TEXT, true)
    return
  }

  exitRequestPending = true
  try {
    const exited = await bridge.shutDownPageContainer(EXIT_IMMEDIATELY)
    if (!exited) {
      exitConfirmationArmed = false
      await setHelpText('Could not exit\nDouble tap to try again', true)
    }
  } catch (error) {
    console.error('Could not exit the Even Hub application:', error)
    exitConfirmationArmed = false
    await setHelpText('Could not exit\nDouble tap to try again', true)
  } finally {
    exitRequestPending = false
  }
}

async function handleSingleClick(): Promise<void> {
  if (disposed) return

  if (exitConfirmationArmed) {
    exitConfirmationArmed = false
    await restoreHelpText()
    return
  }

  if (state.mode === 'completed') return

  if (state.mode === 'running') {
    state.remainingMs = remainingNow()
    if (state.remainingMs <= 0) {
      await completeTimer()
      return
    }
    state.deadlineMs = null
    state.mode = 'paused'
    state.view = 'main'
    clearRunTimers()
    await renderCurrentView()
    return
  }

  state.mode = 'running'
  state.deadlineMs = Date.now() + state.remainingMs
  scheduleCountdown()
  await enterCompactWhileRunning()
}

async function handleScroll(direction: 1 | -1): Promise<void> {
  if (disposed || exitConfirmationArmed || state.mode === 'completed') return

  if (state.mode === 'idle') {
    state.configuredMinutes = clamp(state.configuredMinutes + direction, MIN_MINUTES, MAX_MINUTES)
    state.remainingMs = state.configuredMinutes * MINUTE_MS
    saveConfiguredMinutes(state.configuredMinutes)
    state.view = 'main'
    renderMainTimerOnly()
    return
  }

  if (state.mode === 'paused') {
    state.remainingMs = clamp(state.remainingMs + direction * MINUTE_MS, 0, MAX_MINUTES * MINUTE_MS)
    state.view = 'main'
    if (state.remainingMs === 0) await completeTimer()
    else renderMainTimerOnly()
    return
  }

  await revealMainWhileRunning()
}

async function revealMainWhileRunning(): Promise<void> {
  state.view = 'main'
  stopAnimation()
  scheduleCompactMode()
  await renderCurrentView()
}

async function enterCompactWhileRunning(): Promise<void> {
  if (compactTimer !== null) window.clearTimeout(compactTimer)
  compactTimer = null
  stopAnimation()
  state.view = 'compact'
  await renderCurrentView()
  if (isForeground && state.mode === 'running' && state.view === 'compact') startAnimation()
}

function scheduleCompactMode(): void {
  if (compactTimer !== null) window.clearTimeout(compactTimer)
  compactTimer = window.setTimeout(() => {
    compactTimer = null
    if (disposed || !isForeground || state.mode !== 'running') return
    void enterCompactWhileRunning()
  }, MAIN_VISIBLE_MS)
}

function scheduleCountdown(): void {
  clearCountdownTimer()
  if (disposed || !isForeground || state.mode !== 'running') return

  const remaining = remainingNow()
  if (remaining <= 0) {
    void completeTimer()
    return
  }

  state.remainingMs = remaining
  const shownMinutes = displayedMinutes(remaining)
  const untilMinuteChanges = remaining - (shownMinutes - 1) * MINUTE_MS
  countdownTimer = window.setTimeout(() => {
    countdownTimer = null
    if (state.mode !== 'running') return
    state.remainingMs = remainingNow()
    if (state.remainingMs <= 0) {
      void completeTimer()
      return
    }
    void renderTimeOnly()
    scheduleCountdown()
  }, Math.max(20, Math.min(remaining, untilMinuteChanges)))
}

async function reconcileAfterForeground(): Promise<void> {
  if (disposed) return
  if (state.mode === 'running') {
    state.remainingMs = remainingNow()
    if (state.remainingMs <= 0) {
      await completeTimer()
      return
    }
    if (state.view === 'main') scheduleCompactMode()
    scheduleCountdown()
  }
  await renderCurrentView()
  if (state.mode === 'running' && state.view === 'compact') startAnimation()
}

async function completeTimer(): Promise<void> {
  if (disposed || state.mode === 'completed') return
  clearRunTimers()
  state.mode = 'completed'
  state.view = 'main'
  state.deadlineMs = null
  state.remainingMs = 0

  await setHelpText('')
  const revision = ++renderRevision
  enqueueImage(COMPACT, blankImage(COMPACT.width, COMPACT.height), revision)
  enqueueImage(MAIN_VISUAL, completionImage(), revision)
  const completionReady = enqueueImage(MAIN_TIMER, completionTextImage(), revision)

  // Start the three-second hold only after every completion image reaches the
  // device. Otherwise a slow BLE transfer can consume the entire hold time.
  await completionReady
  if (disposed || state.mode !== 'completed') return

  completionTimers.push(window.setTimeout(() => {
    if (disposed || state.mode !== 'completed') return
    completionTimers = []
    state.mode = 'idle'
    state.remainingMs = state.configuredMinutes * MINUTE_MS
    state.animationFrame = 0
    void renderCurrentView()
  }, COMPLETION_DURATION_MS))
}

async function renderCurrentView(): Promise<void> {
  if (disposed) return
  const revision = ++renderRevision

  if (state.view === 'compact' && state.mode === 'running') {
    await setHelpText('')
    // Put the useful frame first. The two cheap black clears can follow while
    // the compact timer is already visible.
    const compactReady = enqueueImage(
      COMPACT,
      compactImage(displayedMinutes(remainingNow()), state.animationFrame),
      revision,
    )
    enqueueImage(MAIN_VISUAL, blankImage(MAIN_VISUAL.width, MAIN_VISUAL.height), revision)
    enqueueImage(MAIN_TIMER, blankImage(MAIN_TIMER.width, MAIN_TIMER.height), revision)
    await compactReady
    return
  }

  enqueueImage(MAIN_VISUAL, mainVisualImage(), revision)
  enqueueImage(MAIN_TIMER, timerImage(`${displayedMinutes(currentRemaining())} min`), revision)
  enqueueImage(COMPACT, blankImage(COMPACT.width, COMPACT.height), revision)
  await setHelpText(MAIN_HELP_TEXT)
}

async function restoreHelpText(): Promise<void> {
  const content = state.view === 'compact' || state.mode === 'completed' ? '' : MAIN_HELP_TEXT
  await setHelpText(content, true)
}

async function renderTimeOnly(): Promise<void> {
  if (disposed || !isForeground || state.mode !== 'running') return
  const revision = ++renderRevision
  if (state.view === 'compact') {
    enqueueImage(COMPACT, compactImage(displayedMinutes(remainingNow()), state.animationFrame), revision)
  }
  else enqueueImage(MAIN_TIMER, timerImage(`${displayedMinutes(remainingNow())} min`), revision)
}

function renderMainTimerOnly(): void {
  if (disposed) return
  const revision = ++renderRevision
  enqueueImage(
    MAIN_TIMER,
    timerImage(`${displayedMinutes(currentRemaining())} min`),
    revision,
  )
}

function startAnimation(): void {
  stopAnimation()
  if (disposed || state.mode !== 'running') return
  animationTimer = window.setInterval(() => {
    if (disposed || !isForeground || state.mode !== 'running') return
    state.animationFrame = (state.animationFrame + 1) % 2
    if (state.view !== 'compact') return
    const revision = ++renderRevision
    enqueueImage(COMPACT, compactImage(displayedMinutes(remainingNow()), state.animationFrame), revision)
  }, ANIMATION_FRAME_MS)
}

function stopAnimation(): void {
  if (animationTimer !== null) window.clearInterval(animationTimer)
  animationTimer = null
}

function remainingNow(): number {
  return state.deadlineMs === null ? state.remainingMs : Math.max(0, state.deadlineMs - Date.now())
}

function currentRemaining(): number {
  return state.mode === 'running' ? remainingNow() : state.remainingMs
}

function displayedMinutes(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / MINUTE_MS))
}

function clearCountdownTimer(): void {
  if (countdownTimer !== null) window.clearTimeout(countdownTimer)
  countdownTimer = null
}

function clearRunTimers(): void {
  clearCountdownTimer()
  if (compactTimer !== null) window.clearTimeout(compactTimer)
  compactTimer = null
  stopAnimation()
}

function cleanup(): void {
  disposed = true
  exitConfirmationArmed = false
  exitRequestPending = false
  renderRevision += 1
  clearRunTimers()
  completionTimers.forEach(timer => window.clearTimeout(timer))
  completionTimers = []
}

function enqueueImage(spec: ImageSpec, imagePromise: Promise<Uint8Array>, revision: number): Promise<void> {
  imageRevisions.set(spec.id, revision)
  imageQueue = imageQueue
    .then(async () => {
      const imageData = await imagePromise
      if (disposed || imageRevisions.get(spec.id) !== revision) return
      const update = new ImageRawDataUpdate({
        containerID: spec.id,
        containerName: spec.name,
        imageData,
      })
      let result = await bridge.updateImageRawData(update)
      if (result === ImageRawDataUpdateResult.sendFailed) {
        await delay(200)
        if (disposed || imageRevisions.get(spec.id) !== revision) return
        result = await bridge.updateImageRawData(update)
      }
      if (result !== ImageRawDataUpdateResult.success) {
        throw new Error(`Image update failed for ${spec.name}: ${result}`)
      }
    })
    .catch(reportDisplayError)
  return imageQueue
}

function reportDisplayError(error: unknown): void {
  console.error('Fuel Timer display error:', error)
  if (displayErrorShown || disposed) return
  displayErrorShown = true
  const detail = error instanceof Error ? error.message.split(':').at(-1)?.trim() : 'unknown'
  void setHelpText(`Display error: ${detail}\nDouble tap to exit`, true)
}

async function setHelpText(content: string, force = false): Promise<void> {
  if (disposed || (exitConfirmationArmed && !force) || (displayErrorShown && !force)) return
  try {
    const wireContent = content.length === 0 ? HIDDEN_HELP_TEXT : content
    const updated = await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: HELP.id,
        containerName: HELP.name,
        contentOffset: 0,
        contentLength: wireContent.length,
        content: wireContent,
      }),
    )
    if (!updated) console.error('Fuel Timer text update was rejected by the device')
  } catch (error) {
    console.error('Fuel Timer text update error:', error)
  }
}

function mainVisualImage(): Promise<Uint8Array> {
  return cachedMugAndLogoImage(
    'main-static',
    MAIN_VISUAL.width,
    MAIN_VISUAL.height,
    (context, mug, logo) => {
      paintBackground(context, MAIN_VISUAL.width, MAIN_VISUAL.height)
      drawRealisticMug(context, mug, 0, 0, 120, 144, 0.9, 0)
      drawImageAsset(context, logo, 138, 2, 140, 140)
    },
  )
}

function completionImage(): Promise<Uint8Array> {
  return cachedMugImage('complete', MAIN_VISUAL.width, MAIN_VISUAL.height, (context, mug) => {
    paintBackground(context, MAIN_VISUAL.width, MAIN_VISUAL.height)
    drawRealisticMug(context, mug, 152, 0, 120, 144, 0, 0)
  })
}

function completionTextImage(): Promise<Uint8Array> {
  return cachedLogoImage('completion-text', MAIN_TIMER.width, MAIN_TIMER.height, (context, logo) => {
    paintBackground(context, MAIN_TIMER.width, MAIN_TIMER.height)
    drawImageAsset(context, logo, 0, 4, 136, 136)
  })
}

function timerImage(label: string): Promise<Uint8Array> {
  return cachedImage(`timer-${label}`, MAIN_TIMER.width, MAIN_TIMER.height, context => {
    paintBackground(context, MAIN_TIMER.width, MAIN_TIMER.height)
    context.fillStyle = '#ffffff'
    context.font = '900 52px "Arial Black", sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const measuredWidth = Math.max(1, context.measureText(label).width)
    const horizontalScale = Math.min(1.12, (MAIN_TIMER.width - 8) / measuredWidth)
    context.save()
    context.translate(MAIN_TIMER.width / 2, MAIN_TIMER.height / 2)
    context.scale(horizontalScale, 1)
    context.fillText(label, 0, 0)
    context.restore()
  })
}

function compactImage(minutes: number, frame: number): Promise<Uint8Array> {
  return cachedMugImage(`compact-${minutes}-${frame}`, COMPACT.width, COMPACT.height, (context, mug) => {
    paintBackground(context, COMPACT.width, COMPACT.height)
    const levels = [0.9, 0.12]
    drawRealisticMug(context, mug, 5, 6, 42, 51, levels[frame % 2] ?? levels[0], 0)
    context.fillStyle = '#ffffff'
    context.font = '900 24px "Arial Black", sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const label = `${minutes} min`
    const measuredWidth = Math.max(1, context.measureText(label).width)
    const textLeft = 58
    const textRight = 156
    const horizontalScale = Math.min(1.12, (textRight - textLeft) / measuredWidth)
    context.save()
    context.translate((textLeft + textRight) / 2, 32)
    context.scale(horizontalScale, 1)
    context.fillText(label, 0, 0)
    context.restore()
  })
}

function blankImage(width: number, height: number): Promise<Uint8Array> {
  return cachedImage(`blank-${width}-${height}`, width, height, context => paintBackground(context, width, height))
}

function cachedImage(
  key: string,
  width: number,
  height: number,
  painter: (context: CanvasRenderingContext2D) => void,
): Promise<Uint8Array> {
  const existing = imageCache.get(key)
  if (existing) return existing
  const promise = canvasPng(width, height, painter)
  imageCache.set(key, promise)
  return promise
}

function cachedMugImage(
  key: string,
  width: number,
  height: number,
  painter: (context: CanvasRenderingContext2D, mug: HTMLImageElement) => void,
): Promise<Uint8Array> {
  const existing = imageCache.get(key)
  if (existing) return existing
  const promise = mugImage.then(mug => canvasPng(width, height, context => painter(context, mug)))
  imageCache.set(key, promise)
  return promise
}

function cachedLogoImage(
  key: string,
  width: number,
  height: number,
  painter: (context: CanvasRenderingContext2D, logo: HTMLImageElement) => void,
): Promise<Uint8Array> {
  const existing = imageCache.get(key)
  if (existing) return existing
  const promise = fuelUpImage.then(logo => canvasPng(width, height, context => painter(context, logo)))
  imageCache.set(key, promise)
  return promise
}

function cachedMugAndLogoImage(
  key: string,
  width: number,
  height: number,
  painter: (
    context: CanvasRenderingContext2D,
    mug: HTMLImageElement,
    logo: HTMLImageElement,
  ) => void,
): Promise<Uint8Array> {
  const existing = imageCache.get(key)
  if (existing) return existing
  const promise = Promise.all([mugImage, fuelUpImage]).then(([mug, logo]) => (
    canvasPng(width, height, context => painter(context, mug, logo))
  ))
  imageCache.set(key, promise)
  return promise
}

function canvasPng(
  width: number,
  height: number,
  painter: (context: CanvasRenderingContext2D) => void,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return Promise.reject(new Error('Canvas 2D is unavailable'))
  context.imageSmoothingEnabled = false
  painter(context)
  quantizeCanvasToGray4(context, width, height)

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Failed to encode PNG image'))
        return
      }
      blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject)
    }, 'image/png')
  })
}

function quantizeCanvasToGray4(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const image = context.getImageData(0, 0, width, height)
  for (let index = 0; index < image.data.length; index += 4) {
    const luminance = (
      image.data[index] * 0.2126
      + image.data[index + 1] * 0.7152
      + image.data[index + 2] * 0.0722
    )
    const gray4 = Math.round(luminance / 17) * 17
    image.data[index] = gray4
    image.data[index + 1] = gray4
    image.data[index + 2] = gray4
    image.data[index + 3] = 255
  }
  context.putImageData(image, 0, 0)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds))
}

function paintBackground(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.fillStyle = '#000000'
  context.fillRect(0, 0, width, height)
}

function drawRealisticMug(
  context: CanvasRenderingContext2D,
  mug: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  fillLevel: number,
  lift: number,
): void {
  const mugY = y + lift
  const innerX = x + width * 0.27
  const innerWidth = width * 0.38
  const innerBottom = mugY + height * 0.78
  const maximumBeerHeight = height * 0.52
  const beerHeight = maximumBeerHeight * fillLevel

  if (beerHeight > 0) {
    const liquidTop = innerBottom - beerHeight
    context.fillStyle = '#777777'
    context.fillRect(innerX, liquidTop, innerWidth, beerHeight)
    context.fillStyle = '#eeeeee'
    context.fillRect(innerX, liquidTop, innerWidth, Math.max(2, height * 0.055))
    context.fillStyle = '#bbbbbb'
    const bubbleSize = Math.max(1, Math.round(width * 0.025))
    context.fillRect(innerX + innerWidth * 0.22, liquidTop + beerHeight * 0.38, bubbleSize, bubbleSize)
    context.fillRect(innerX + innerWidth * 0.58, liquidTop + beerHeight * 0.62, bubbleSize, bubbleSize)
    context.fillRect(innerX + innerWidth * 0.76, liquidTop + beerHeight * 0.27, bubbleSize, bubbleSize)
  }

  context.save()
  context.imageSmoothingEnabled = true
  context.drawImage(mug, x, mugY, width, height)
  context.restore()
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load image asset: ${url}`))
    image.src = url
  })
}

function drawImageAsset(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  context.save()
  context.imageSmoothingEnabled = true
  context.drawImage(image, x, y, width, height)
  context.restore()
}

function loadConfiguredMinutes(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_MINUTES
    const parsed = JSON.parse(raw) as Partial<StoredSettings>
    if (!Number.isInteger(parsed.minutes)) return DEFAULT_MINUTES
    return clamp(parsed.minutes ?? DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES)
  } catch (error) {
    console.warn('Could not load Fuel Timer settings:', error)
    return DEFAULT_MINUTES
  }
}

function saveConfiguredMinutes(minutes: number): void {
  try {
    const settings: StoredSettings = { minutes }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (error) {
    console.warn('Could not save Fuel Timer settings:', error)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
