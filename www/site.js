const still = matchMedia("(prefers-reduced-motion: reduce)")

// The hero's floating marks lean with the pointer, nearer ones more, and rest while off screen.
const marks = document.querySelector(".marks")

if (marks !== null && !still.matches && matchMedia("(pointer: fine)").matches) {
  addEventListener(
    "pointermove",
    (e) => {
      marks.style.setProperty("--px", `${(e.clientX / innerWidth - 0.5) * -28}px`)
      marks.style.setProperty("--py", `${(e.clientY / innerHeight - 0.5) * -20}px`)
    },
    { passive: true },
  )
}

if (marks !== null) {
  new IntersectionObserver(([entry]) =>
    marks.classList.toggle("resting", !entry?.isIntersecting),
  ).observe(marks)
}

// A card plays its drawing while it's .on: hovered where a pointer hovers, and on a touch screen while
// it crosses the middle of the screen (a tap there would leave :hover stuck).
const hovers = matchMedia("(hover: hover)")

const middle = new IntersectionObserver(
  (entries) => {
    if (hovers.matches) return

    for (const entry of entries)
      entry.target.dispatchEvent(new Event(entry.isIntersecting ? "on" : "off"))
  },
  { rootMargin: "-35% 0px -35% 0px" },
)

for (const card of document.querySelectorAll(".piece, .tile")) {
  const loops = () => card.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation)

  card.addEventListener("on", () => {
    card.classList.add("on", "live")

    for (const loop of loops()) {
      loop.effect?.updateTiming({ iterations: Infinity })
      loop.play()
    }
  })

  card.addEventListener("off", () => {
    card.classList.remove("on")

    const running = loops()

    for (const loop of running) {
      const cycle = loop.effect?.getComputedTiming().currentIteration

      if (cycle === null || cycle === undefined) loop.cancel()
      else loop.effect?.updateTiming({ iterations: cycle + 1 })
    }

    void Promise.allSettled(running.map((loop) => loop.finished)).then(() =>
      card.classList.toggle("live", card.classList.contains("on")),
    )
  })

  card.addEventListener("pointerenter", () => {
    if (hovers.matches) card.dispatchEvent(new Event("on"))
  })

  card.addEventListener("pointerleave", () => {
    if (hovers.matches) card.dispatchEvent(new Event("off"))
  })

  middle.observe(card)
}

for (const marquee of document.querySelectorAll(".marquee")) {
  marquee.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLElement)) return

    const mark = event.target.getBoundingClientRect()
    const row = marquee.getBoundingClientRect()
    marquee.scrollLeft += mark.left - row.left - (row.width - mark.width) / 2
  })
}

let tappedMark = null

let logoPress = null

const dismissLogoName = () => {
  tappedMark?.classList.remove("show-name")
  tappedMark = null
}

addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") return

  dismissLogoName()

  if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".marquee"))
    document.activeElement.blur()

  const row = event.target instanceof Element ? event.target.closest(".marquee") : null

  if (row === null) return

  const mark = Array.from(row.querySelectorAll("li")).find((item) => {
    const box = item.getBoundingClientRect()

    return (
      event.clientX >= box.left - 6 &&
      event.clientX <= box.right + 6 &&
      event.clientY >= box.top - 6 &&
      event.clientY <= box.bottom + 6
    )
  })

  if (!(mark instanceof HTMLElement)) return

  event.preventDefault()
  tappedMark = mark
  mark.classList.add("show-name")
  mark.style.removeProperty("--label-shift")
  const label = mark.querySelector("span").getBoundingClientRect()
  const bounds = row.getBoundingClientRect()
  const shift = Math.max(bounds.left + 4 - label.left, Math.min(0, bounds.right - 4 - label.right))
  mark.style.setProperty("--label-shift", `${shift}px`)
  logoPress = { x: event.clientX, y: event.clientY }
})

addEventListener("pointerup", (event) => {
  if (logoPress === null) return

  if (Math.hypot(event.clientX - logoPress.x, event.clientY - logoPress.y) > 8) dismissLogoName()
  logoPress = null
})

addEventListener("pointercancel", () => {
  dismissLogoName()
  logoPress = null
})

addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Tab") dismissLogoName()
})

// "Connect once": each strip gets a second, hidden copy of its marks so it can loop without a seam.
if (!still.matches) {
  for (const marquee of document.querySelectorAll(".marquee")) {
    const list = marquee.querySelector("ul")

    if (list === null) continue

    const copies = Array.from(list.children, (mark) => {
      const copy = mark.cloneNode(true)

      if (copy instanceof HTMLElement) {
        copy.setAttribute("aria-hidden", "true")
        copy.inert = true
      }

      return copy
    })

    list.append(...copies)
    marquee.classList.add("moving")
  }
}

// The story: the big button starts it with sound; then the bar under the frame runs it, so nothing
// covers the film's captions. Full screen hands over to the player's own controls.
const film = document.querySelector(".film")

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`

if (film !== null) {
  const video = film.querySelector("video")
  const start = film.querySelector(".film-play")
  const toggle = film.querySelector(".film-toggle")
  const seek = film.querySelector(".film-seek")
  const now = film.querySelector(".film-now")
  const mute = film.querySelector(".film-mute")
  const full = film.querySelector(".film-full")
  let dragging = false

  const poster = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return

      video.poster = video.dataset.poster
      poster.disconnect()
    },
    { rootMargin: "200px" },
  )

  poster.observe(video)

  const show = () => {
    const t = video.currentTime
    const d = video.duration || Number(seek.max)
    seek.max = String(d)

    if (!dragging) seek.value = String(t)
    seek.style.setProperty("--p", `${(Number(seek.value) / d) * 100}%`)
    now.textContent = clock(dragging ? Number(seek.value) : t)
  }

  const tick = () => {
    show()

    if (!video.paused) requestAnimationFrame(tick)
  }

  const play = () => {
    film.classList.add("started")
    void video.play()
  }

  const flip = () => (video.paused || video.ended ? play() : video.pause())

  start.addEventListener("click", () => {
    play()
    // Keyboard people keep their place (Space pauses); a tap or click shows no ring for it.
    toggle.focus({ focusVisible: false })
  })
  toggle.addEventListener("click", flip)
  // With its own controls on (full screen), the player already pauses on a click.
  video.addEventListener("click", () => video.controls || flip())

  video.addEventListener("play", () => {
    film.classList.add("playing")
    toggle.setAttribute("aria-label", "Pause")
    requestAnimationFrame(tick)
  })
  video.addEventListener("pause", () => {
    film.classList.remove("playing")
    toggle.setAttribute("aria-label", "Play")
    show()
  })
  video.addEventListener("loadedmetadata", show)
  video.addEventListener("seeked", show)

  seek.addEventListener("pointerdown", () => (dragging = true))
  seek.addEventListener("input", () => {
    film.classList.add("started")
    video.currentTime = Number(seek.value)
    show()
  })

  // A press that doesn't move the thumb fires no change, so letting go ends the drag too.
  for (const end of ["change", "pointerup", "pointercancel"]) {
    seek.addEventListener(end, () => {
      dragging = false
      show()
    })
  }

  mute.addEventListener("click", () => (video.muted = !video.muted))
  // Full screen's own controls can mute it too, so the bar follows the video, not its button.
  video.addEventListener("volumechange", () => {
    film.classList.toggle("muted", video.muted)
    mute.setAttribute("aria-label", video.muted ? "Unmute" : "Mute")
  })

  full.addEventListener("click", () => {
    film.classList.add("started")

    if (video.requestFullscreen) {
      void video.requestFullscreen().then(() => video.paused && video.play())
    } else if (video.webkitEnterFullscreen) {
      // iPhone Safari: only the video element goes full screen, with its own controls.
      video.webkitEnterFullscreen()
      void video.play()
    }
  })

  // In full screen there's no bar, so the player shows its own controls there and only there.
  document.addEventListener("fullscreenchange", () => {
    video.controls = document.fullscreenElement === video
  })
}

// Phones show :active only on a page that listens for touches.
addEventListener("touchstart", () => {}, { passive: true })

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

// Copy prompt copies the prompt the server wrote into #prompt (naming the OpenBelt it's on, whose
// /start.md walks an agent through a first tool). The copy happens inside the click (a hidden field
// and the browser's own copy), which works where the clipboard API is blocked, such as a page shown
// inside another app. "Copied" shows only when a copy happened; otherwise the prompt is selected for
// ⌘C. Under the hero's button, a line then says what to do with it.
const copyNow = (text) => {
  const focused = document.activeElement
  const field = document.createElement("textarea")

  field.value = text
  field.setAttribute("readonly", "")
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none"
  document.body.append(field)
  field.select()

  let copied = false

  try {
    copied = document.execCommand("copy")
  } catch {
    copied = false
  }

  field.remove()

  if (focused instanceof HTMLElement) focused.focus()

  return copied
}

const copyNext = document.querySelector(".copy-next")

const copyPrompt = async (button) => {
  const source = document.getElementById(button.dataset.copy ?? "")
  const text = (source?.textContent ?? "").replaceAll(/\s+/g, " ").trim()
  let copied = copyNow(text)

  if (!copied && navigator.clipboard !== undefined)
    copied = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    )

  if (!copied) {
    if (source !== null) {
      source.hidden = false
      getSelection()?.selectAllChildren(source)
    }

    return
  }

  button.classList.remove("copied")
  void button.offsetWidth
  button.classList.add("copied")
  setTimeout(() => button.classList.remove("copied"), 1500)

  if (copyNext === null || !button.classList.contains("copy-prompt")) return

  // The first copy brings the line in (style.css); each copy after it nudges the line, flashes it
  // bright and springs its check, so a press always gets an answer down here too.
  if (copyNext.childElementCount === 0) {
    copyNext.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="brand/icons/sprite.svg#check" /></svg>Now paste it into your agent'

    return
  }

  if (still.matches) return

  const tone = getComputedStyle(document.documentElement)

  copyNext.animate(
    {
      transform: ["translateY(-4px)", "none"],
      color: [
        tone.getPropertyValue("--openbelt-color-primary").trim(),
        tone.getPropertyValue("--openbelt-color-muted").trim(),
      ],
    },
    { duration: 700, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  )
  copyNext
    .querySelector(".icon")
    ?.animate(
      { transform: ["scale(1.6) rotate(-14deg)", "none"] },
      { duration: 500, easing: "cubic-bezier(0.3, 1.6, 0.5, 1)" },
    )
}

for (const button of document.querySelectorAll("[data-copy]"))
  button.addEventListener("click", () => void copyPrompt(button))

// Start building leaves the page, which takes longer than a press shows: the button holds its
// pressed look until the next page paints. A page the back button restores shows it at rest.
const goers = document.querySelectorAll("a.btn, a.nav-cta")

for (const link of goers)
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return

    link.classList.add("going")
  })

addEventListener("pageshow", () => {
  for (const link of goers) link.classList.remove("going")
})

// A demo session's terminal: the prompt, what's typed into it, and its one line of status.
const parts = (session) => ({
  typed: session.window.querySelector(".t-typed"),
  prompt: session.window.querySelector(".t-prompt"),
  status: session.window.querySelector(".t-status"),
  text: session.window.querySelector(".t-text"),
})

// Lights what's new for a moment, again if it already was.
const light = (el) => {
  el.classList.remove("lit")
  void el.offsetWidth
  el.classList.add("lit")
}

// The demo: Ben asks Codex for a support app, a letter every 24ms, and it slides into the browser
// once it's live; then Ana asks Claude Code to change the same app, and it changes in place. Round
// and round, only while it's on screen. The page's HTML is its finished state, which is what
// reduced motion shows.
const demo = document.querySelector(".demo")

if (demo !== null && !still.matches) {
  demo.classList.add("animating")

  const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)"
  const app = demo.querySelector(".app")
  const themes = [...demo.querySelectorAll(".theme")]

  // Each session: its window, the relays it lights, what it's asked, what it does, what it says.
  const sessions = [
    {
      window: demo.querySelector(".s1"),
      relays: [demo.querySelector(".r1"), demo.querySelector(".rm")],
      prompt: "Group open Zendesk tickets by theme",
      steps: [
        "Reading OpenBelt's docs",
        "Connecting to Zendesk",
        "Writing 3 files",
        "Checking it in a browser",
      ],
      done: "Live at acme.openbelt.app/support",
    },
    {
      window: demo.querySelector(".s2"),
      relays: [demo.querySelector(".r2"), demo.querySelector(".rm")],
      prompt: "Link each theme to its Sentry activity",
      steps: ["Found support on OpenBelt", "Connecting to Sentry", "Changing 2 files"],
      done: "Added Sentry activity to each theme",
    },
  ]

  const shown = () => demo.offsetParent !== null && document.visibilityState === "visible"

  // Nothing typed yet: the first window empty, the second waiting its turn, the browser blank.
  const reset = () => {
    demo.classList.remove("linked")
    app.classList.add("empty")

    for (const theme of themes) theme.querySelector(".trace").classList.remove("revealed")

    for (const [at, session] of sessions.entries()) {
      const p = parts(session)

      p.typed.textContent = ""
      p.status.className = "t-status blank"
      session.window.classList.toggle("idle", at === 1)

      for (const relay of session.relays) relay.classList.remove("sending", "arrived")
    }
  }

  const run = async (session, shipped) => {
    const p = parts(session)

    for (const other of sessions) other.window.classList.toggle("idle", other !== session)
    p.prompt.classList.add("typing")
    await wait(350)

    for (let at = 1; at <= session.prompt.length; at++) {
      p.typed.textContent = session.prompt.slice(0, at)
      await wait(24)
    }

    await wait(300)
    p.prompt.classList.remove("typing")

    for (const relay of session.relays) relay.classList.add("sending")

    p.status.className = "t-status working"

    for (const step of session.steps) {
      p.text.textContent = `${step}…`
      await wait(650)
    }

    for (const relay of session.relays) {
      relay.classList.remove("sending")
      relay.classList.add("arrived")
    }

    p.status.className = "t-status"
    p.text.textContent = session.done
    await shipped()
  }

  // The app arrives: it fades in, its themes settle one after another and their bars fill.
  const arrive = () => {
    app.classList.remove("empty")

    themes.forEach((theme, at) => {
      theme.animate(
        { opacity: [0, 1], transform: ["translateY(8px)", "none"] },
        { duration: 520, delay: 120 + at * 80, easing: ease, fill: "backwards" },
      )
      theme
        .querySelector(".meter i")
        .animate(
          { transform: ["scaleX(0)", "none"] },
          { duration: 800, delay: 260 + at * 80, easing: ease, fill: "backwards" },
        )
    })
  }

  // Ana's change: Sentry joins the sources, then its activity appears one theme at a time.
  const change = async () => {
    const zendesk = demo.querySelector(".sources .source")
    const previousLeft = zendesk.getBoundingClientRect().left

    demo.classList.add("linked")
    zendesk.animate(
      {
        transform: [`translateX(${previousLeft - zendesk.getBoundingClientRect().left}px)`, "none"],
      },
      { duration: 500, easing: ease },
    )
    demo
      .querySelector(".sources .sentry")
      .animate(
        { opacity: [0, 1], transform: ["translateX(8px)", "none"] },
        { duration: 420, delay: 100, easing: ease, fill: "backwards" },
      )
    light(demo.querySelector(".sentry"))

    for (const theme of themes) {
      const trace = theme.querySelector(".trace")

      trace.classList.add("revealed")
      trace.animate(
        { opacity: [0, 1], transform: ["translateY(4px)", "none"] },
        { duration: 420, easing: ease, fill: "backwards" },
      )
      light(theme)
      await wait(650)
    }
  }

  const play = async () => {
    reset()
    await run(sessions[0], arrive)
    await wait(2200)

    for (const relay of sessions[0].relays) relay.classList.remove("arrived")
    await run(sessions[1], change)
    await wait(7000)

    while (!shown()) await wait(400)

    const fades = [...demo.querySelectorAll(".terminal, .app, .relay")].map((el) =>
      el.animate({ opacity: [1, 0] }, { duration: 800, easing: ease, fill: "forwards" }),
    )

    await Promise.all(fades.map((fade) => fade.finished))
    reset()

    for (const fade of fades) fade.cancel()
    await wait(500)

    void play()
  }

  void (async () => {
    while (!shown()) await wait(400)

    void play()
  })()
}
