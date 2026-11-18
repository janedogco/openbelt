// The inspector: properties of the selected clip (transform with keyframes, crop,
// timing, audio, text, shape, color grading, transitions) or of the project.
import { state, on, emit, commit, selectedClip, selectedClips, seek } from "./store.js"
import {
  ANIM,
  PRESETS,
  TRANSITIONS,
  FONTS,
  TEXT_STYLES,
  SIZES,
  FX_DEFAULT,
  propAt,
  keyAt,
  setKey,
  removeKey,
  setProp,
  presetFx,
  cssFilter,
  defaultProps,
  projectDuration,
  clipEnd,
} from "./model.js"
import * as A from "./actions.js"
import {
  h,
  icon,
  iconBtn,
  btn,
  clamp,
  fmtTime,
  fmtDur,
  fmtBytes,
  menu,
  busy,
  ratioBox,
} from "./ui.js"
import { mediaUrl } from "./media.js"
import { clipMenuItems } from "./timeline.js"

const BLENDS = [
  ["source-over", "Normal"],
  ["multiply", "Multiply"],
  ["screen", "Screen"],
  ["overlay", "Overlay"],
  ["darken", "Darken"],
  ["lighten", "Lighten"],
  ["color-dodge", "Color dodge"],
  ["color-burn", "Color burn"],
  ["hard-light", "Hard light"],
  ["soft-light", "Soft light"],
  ["difference", "Difference"],
  ["exclusion", "Exclusion"],
  ["hue", "Hue"],
  ["saturation", "Saturation"],
  ["color", "Color"],
  ["luminosity", "Luminosity"],
]

export class Inspector {
  constructor(root, { player }) {
    this.root = root
    this.player = player
    this.updaters = []
    this.openSections = new Set([
      "text",
      "transform",
      "audio",
      "timing",
      "shape",
      "color",
      "project",
      "canvas",
    ])
    this.offs = [
      on("selection", () => {
        if (state.sel.size) state.mediaSel = null
        this.build()
      }),
      on("media-select", () => this.build()),
      on("project", () => this.refresh(true)),
      on("time", () => this.refresh(false)),
      on("focus-text", () => {
        const ta = this.root.querySelector("textarea")
        ta?.focus()
        ta?.select()
      }),
    ]
    this.build()
  }
  destroy() {
    this.offs.forEach((f) => f())
  }

  refresh(structural) {
    const c = selectedClip()
    const ms = !c && state.mediaSel ? "media:" + state.mediaSel : null
    const key = c
      ? c.id + ":" + c.kind
      : ms || (state.sel.size ? "multi" + state.sel.size : "project")
    if (structural && key !== this.key) return this.build()
    for (const u of this.updaters) u(structural)
  }

  build() {
    this.updaters = []
    const c = selectedClip()
    this.key = c ? c.id + ":" + c.kind : state.sel.size ? "multi" + state.sel.size : "project"
    const scroll = this.root.scrollTop
    let body
    const ms = !c && state.mediaSel ? state.media.get(state.mediaSel) : null
    if (ms) this.key = "media:" + ms.id
    if (c) body = this.clipPanel(c)
    else if (ms) body = this.mediaInfo(ms)
    else if (state.sel.size > 1) body = this.multiPanel()
    else body = this.projectPanel()
    this.root.replaceChildren(body)
    this.root.scrollTop = scroll
  }

  // --- building blocks -------------------------------------------------------------

  section(id, title, children, extra) {
    const open = this.openSections.has(id)
    const sec = h(
      "section",
      { class: "insp-sec" + (open ? " open" : "") },
      h(
        "button",
        {
          class: "insp-sec-head",
          type: "button",
          onclick: () => {
            if (this.openSections.has(id)) this.openSections.delete(id)
            else this.openSections.add(id)
            sec.classList.toggle("open")
          },
        },
        icon("chevRight", 14),
        h("span", {}, title),
        extra || null,
      ),
      h("div", { class: "insp-sec-body" }, children),
    )
    return sec
  }

  // A number row: drag the label to scrub, type a value, optional slider and keyframe toggle.
  num(
    label,
    {
      get,
      set,
      min = -Infinity,
      max = Infinity,
      step = 1,
      unit = "",
      slider = false,
      anim = null,
      fmt,
      scale = 1,
    },
  ) {
    const clip = () => selectedClip()
    const input = h("input", {
      class: "num",
      type: "text",
      inputmode: "decimal",
      "aria-label": label,
    })
    const dec = step < 1 ? Math.ceil(-Math.log10(step) - 1e-9) : 0
    const show = (v) =>
      fmt ? fmt(v) : String(+(Math.round((v * scale) / step) * step).toFixed(dec))
    const key = "num-" + label + "-" + Math.random()
    const apply = (v, coalesce = true) => {
      v = clamp(v, min, max)
      set(v / scale, coalesce ? key : null)
    }
    input.addEventListener("change", () => {
      const v = parseFloat(input.value)
      if (isFinite(v)) apply(v, false)
      else input.value = show(get())
    })
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault()
        const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
        apply(get() * scale + d)
      }
      if (e.key === "Enter") input.blur()
      e.stopPropagation()
    })
    const lab = h("label", { class: "num-label", title: "Drag to change" }, label)
    lab.addEventListener("pointerdown", (e) => {
      e.preventDefault()
      const x0 = e.clientX
      const v0 = get() * scale
      lab.setPointerCapture(e.pointerId)
      const move = (ev) =>
        apply(v0 + Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1))
      const up = () => {
        lab.removeEventListener("pointermove", move)
        lab.removeEventListener("pointerup", up)
      }
      lab.addEventListener("pointermove", move)
      lab.addEventListener("pointerup", up)
    })
    let range = null
    if (slider) {
      range = h("input", { type: "range", min, max, step, "aria-label": label })
      range.addEventListener("input", () => apply(+range.value))
    }
    let kbtn = null
    if (anim) {
      kbtn = h("button", { class: "kbtn", type: "button", title: "Keyframe" })
      kbtn.addEventListener("click", () => {
        const c = clip()
        const lt = state.time - c.start
        const fps = state.project.scene.fps
        commit((p) => {
          const cc = p.clips.find((x) => x.id === c.id)
          if (keyAt(cc, anim, lt, fps) >= 0) removeKey(cc, anim, lt, fps)
          else setKey(cc, anim, clamp(lt, 0, cc.duration), propAt(cc, anim, lt), fps)
        })
      })
    }
    const update = () => {
      const v = get()
      if (document.activeElement !== input) input.value = show(v)
      if (range && document.activeElement !== range) range.value = v * scale
      if (kbtn) {
        const c = clip()
        const lt = state.time - c.start
        const has = !!c.kf?.[anim]?.length
        const at = keyAt(c, anim, lt, state.project.scene.fps) >= 0
        kbtn.replaceChildren(icon(at ? "diamondFill" : "diamond", 13))
        kbtn.classList.toggle("has", has)
        kbtn.classList.toggle("at", at)
        kbtn.title = at ? "Remove keyframe" : "Add keyframe at playhead"
      }
    }
    this.updaters.push(update)
    update()
    return h(
      "div",
      { class: "row num-row" + (slider ? " has-slider" : "") },
      lab,
      range,
      h("div", { class: "num-wrap" }, input, unit ? h("span", { class: "unit" }, unit) : null),
      kbtn,
    )
  }

  color(label, { get, set, allowNone = false }) {
    const input = h("input", { type: "color", "aria-label": label })
    const key = "color-" + label + Math.random()
    input.addEventListener("input", () => set(input.value, key))
    const none = allowNone
      ? h("button", {
          class: "chip small",
          type: "button",
          onclick: () => set(get() ? "" : "#000000", null),
        })
      : null
    const swatch = h("label", { class: "swatch" }, input)
    const update = () => {
      const v = get()
      const hex = (v || "#000000").slice(0, 7)
      if (document.activeElement !== input) input.value = hex
      swatch.style.setProperty("--c", v || "transparent")
      swatch.classList.toggle("none", !v)
      if (none) none.textContent = v ? "None" : "Add"
    }
    this.updaters.push(update)
    update()
    return h(
      "div",
      { class: "row" },
      h("label", { class: "row-label" }, label),
      h("div", { class: "row-ctl" }, swatch, none),
    )
  }

  select(label, options, { get, set }) {
    const s = h(
      "select",
      { "aria-label": label, onchange: () => set(s.value) },
      options.map(([v, l]) => h("option", { value: v }, l)),
    )
    const update = () => {
      if (document.activeElement !== s) s.value = String(get())
    }
    this.updaters.push(update)
    update()
    return h(
      "div",
      { class: "row" },
      h("label", { class: "row-label" }, label),
      h("div", { class: "row-ctl" }, s),
    )
  }

  seg(label, options, { get, set }) {
    const btns = options.map(([v, l, ic]) =>
      h(
        "button",
        {
          class: "seg-btn",
          type: "button",
          title: typeof l === "string" ? l : v,
          onclick: () => set(v),
        },
        ic ? icon(ic, 15) : l,
      ),
    )
    const update = () => btns.forEach((b, i) => b.classList.toggle("on", options[i][0] === get()))
    this.updaters.push(update)
    update()
    return h(
      "div",
      { class: "row" },
      label ? h("label", { class: "row-label" }, label) : null,
      h("div", { class: "seg" }, btns),
    )
  }

  toggle(label, { get, set }) {
    const b = h("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-label": label,
      onclick: () => set(!get()),
    })
    const update = () => {
      b.classList.toggle("on", !!get())
      b.setAttribute("aria-checked", String(!!get()))
    }
    this.updaters.push(update)
    update()
    return h(
      "div",
      { class: "row" },
      h("label", { class: "row-label" }, label),
      h("div", { class: "row-ctl" }, b),
    )
  }

  // --- clip ------------------------------------------------------------------------

  clipPanel(c0) {
    const id = c0.id
    const C = () => state.project.clips.find((x) => x.id === id)
    const fps = () => state.project.scene.fps
    const lt = () => state.time - C().start
    const edit = (fn, coalesce) =>
      commit(
        (p) => {
          const c = p.clips.find((x) => x.id === id)
          if (c) fn(c, p)
        },
        { coalesce },
      )
    const m = c0.mediaId ? state.media.get(c0.mediaId) : null
    const visual = c0.kind !== "audio"
    const hasSound = c0.kind === "audio" || (c0.kind === "video" && m?.hasAudio)
    const isMedia = c0.kind === "video" || c0.kind === "image"
    const S = state.project.scene

    const nameInput = h("input", {
      class: "insp-name",
      value: c0.name,
      "aria-label": "Clip name",
      onchange: () => edit((c) => (c.name = nameInput.value.trim() || c.name)),
      onkeydown: (e) => {
        e.stopPropagation()
        if (e.key === "Enter") nameInput.blur()
      },
    })
    const head = h(
      "div",
      { class: "insp-head" },
      h(
        "div",
        { class: "insp-kind k-" + c0.kind },
        icon(
          {
            video: "film",
            audio: "music",
            image: "image",
            text: "text",
            shape: "shape",
            color: "palette",
          }[c0.kind],
          16,
        ),
      ),
      nameInput,
      iconBtn("more", "Clip actions", (e) => {
        const r = e.currentTarget.getBoundingClientRect()
        menu(r.left - 160, r.bottom + 4, clipMenuItems(C(), m))
      }),
    )
    const out = [head]

    // time info
    const info = h("div", { class: "insp-info" })
    this.updaters.push(() => {
      const c = C()
      if (!c) return
      info.textContent =
        `${fmtTime(c.start, fps())} → ${fmtTime(clipEnd(c), fps())} · ${c.duration.toFixed(2)}s` +
        (m ? ` · ${m.width ? m.width + "×" + m.height : ""}` : "")
    })
    out.push(info)

    // ---- text
    if (c0.kind === "text") {
      const ta = h("textarea", { class: "insp-text", rows: 3, "aria-label": "Text" })
      ta.addEventListener("input", () => edit((c) => (c.text.content = ta.value), "text-" + id))
      ta.addEventListener("keydown", (e) => e.stopPropagation())
      this.updaters.push(() => {
        if (document.activeElement !== ta) ta.value = C()?.text.content ?? ""
      })
      const T = (k) => ({
        get: () => C().text[k],
        set: (v, co) => edit((c) => (c.text[k] = v), co),
      })
      out.push(
        this.section("text", "Text", [
          ta,
          h(
            "div",
            { class: "style-chips" },
            TEXT_STYLES.map((s) =>
              h(
                "button",
                {
                  class: "style-chip",
                  type: "button",
                  style: {
                    fontFamily: `"${s.text.font}"`,
                    fontWeight: s.text.weight,
                    color: s.text.color,
                    background: s.text.bg || "var(--panel-3)",
                    textShadow: s.text.glow ? `0 0 8px ${s.text.glow}` : "",
                    WebkitTextStroke: s.text.stroke ? `1px ${s.text.stroke}` : "",
                  },
                  onclick: () =>
                    edit((c) => {
                      const keep = c.text.content
                      c.text = {
                        ...c.text,
                        bg: "",
                        stroke: "",
                        strokeWidth: 0,
                        glow: "",
                        shadow: false,
                        upper: false,
                        ...s.text,
                        content: keep,
                      }
                    }),
                },
                s.label,
              ),
            ),
          ),
          this.select(
            "Font",
            FONTS.map((f) => [f, f]),
            T("font"),
          ),
          this.num("Size", { ...T("size"), min: 6, max: 1000, slider: true, unit: "px" }),
          this.select(
            "Weight",
            [
              [300, "Light"],
              [400, "Regular"],
              [500, "Medium"],
              [600, "Semibold"],
              [700, "Bold"],
              [800, "Extra bold"],
              [900, "Black"],
            ],
            { get: () => C().text.weight, set: (v) => edit((c) => (c.text.weight = +v)) },
          ),
          this.seg(
            "Align",
            [
              ["left", "Left", "alignL"],
              ["center", "Center", "alignC"],
              ["right", "Right", "alignR"],
            ],
            T("align"),
          ),
          this.toggle("Italic", T("italic")),
          this.toggle("Uppercase", T("upper")),
          this.color("Color", T("color")),
          this.color("Background", { ...T("bg"), allowNone: true }),
          this.num("Padding", { ...T("pad"), min: 0, max: 200, unit: "px" }),
          this.color("Outline", { ...T("stroke"), allowNone: true }),
          this.num("Outline width", { ...T("strokeWidth"), min: 0, max: 60, unit: "px" }),
          this.toggle("Shadow", T("shadow")),
          this.color("Glow", { ...T("glow"), allowNone: true }),
          this.num("Letter spacing", { ...T("spacing"), min: -20, max: 100, unit: "px" }),
          this.num("Line height", { ...T("lineHeight"), min: 0.6, max: 3, step: 0.05 }),
          this.num("Wrap width", { ...T("maxWidth"), min: 0, max: 8000, unit: "px" }),
        ]),
      )
    }

    // ---- shape
    if (c0.kind === "shape") {
      const Sh = (k) => ({
        get: () => C().shape[k],
        set: (v, co) => edit((c) => (c.shape[k] = v), co),
      })
      out.push(
        this.section("shape", "Shape", [
          this.seg(
            "Type",
            [
              ["rect", "Rectangle"],
              ["ellipse", "Ellipse"],
            ],
            Sh("type"),
          ),
          this.num("Width", { ...Sh("w"), min: 1, max: 8000, unit: "px" }),
          this.num("Height", { ...Sh("h"), min: 1, max: 8000, unit: "px" }),
          this.num("Corner radius", { ...Sh("radius"), min: 0, max: 2000, unit: "px" }),
          this.color("Fill", { ...Sh("fill"), allowNone: true }),
          this.color("Outline", { ...Sh("stroke"), allowNone: true }),
          this.num("Outline width", { ...Sh("strokeWidth"), min: 0, max: 200, unit: "px" }),
        ]),
      )
    }
    if (c0.kind === "color") {
      out.push(
        this.section("color", "Color", [
          this.color("Fill", {
            get: () => C().color,
            set: (v, co) => edit((c) => (c.color = v), co),
          }),
        ]),
      )
    }

    // ---- transform
    if (visual) {
      const P = (k) => ({
        get: () => propAt(C(), k, lt()),
        set: (v, co) => edit((c) => setProp(c, k, v, state.time - c.start, fps()), co),
        anim: k,
      })
      const prevNext = h(
        "span",
        { class: "kf-nav" },
        iconBtn(
          "stepBack",
          "Previous keyframe",
          (e) => {
            e.stopPropagation()
            this.jumpKey(C(), -1)
          },
          { size: 14 },
        ),
        iconBtn(
          "stepFwd",
          "Next keyframe",
          (e) => {
            e.stopPropagation()
            this.jumpKey(C(), 1)
          },
          { size: 14 },
        ),
      )
      const rows = [
        h(
          "div",
          { class: "pair" },
          this.num("X", { ...P("x"), unit: "px" }),
          this.num("Y", { ...P("y"), unit: "px" }),
        ),
        this.num("Scale", {
          ...P("scale"),
          min: 1,
          max: 1000,
          step: 1,
          scale: 100,
          unit: "%",
          slider: true,
        }),
        this.num("Rotation", { ...P("rotation"), min: -3600, max: 3600, step: 1, unit: "°" }),
        this.num("Opacity", {
          ...P("opacity"),
          min: 0,
          max: 100,
          step: 1,
          scale: 100,
          unit: "%",
          slider: true,
        }),
      ]
      if (isMedia) {
        rows.push(
          this.seg(
            "Fit",
            [
              ["contain", "Fit"],
              ["cover", "Fill"],
              ["fill", "Stretch"],
            ],
            {
              get: () => C().props.fit,
              set: (v) => edit((c) => (c.props.fit = v)),
            },
          ),
        )
      }
      rows.push(
        h(
          "div",
          { class: "row btn-row" },
          h(
            "button",
            {
              class: "chip",
              type: "button",
              onclick: () => edit((c) => (c.props.flipH = !c.props.flipH)),
            },
            icon("flipH", 14),
            "Flip H",
          ),
          h(
            "button",
            {
              class: "chip",
              type: "button",
              onclick: () => edit((c) => (c.props.flipV = !c.props.flipV)),
            },
            icon("flipV", 14),
            "Flip V",
          ),
          h(
            "button",
            {
              class: "chip",
              type: "button",
              onclick: () =>
                edit((c) => {
                  const d = defaultProps(state.project.scene)
                  for (const k of ["x", "y", "scale", "rotation", "opacity"]) {
                    c.props[k] = d[k]
                    delete c.kf[k]
                  }
                  c.props.flipH = c.props.flipV = false
                }),
            },
            "Reset",
          ),
        ),
      )
      out.push(this.section("transform", "Transform", rows, prevNext))
    }

    // ---- crop & style
    if (isMedia || c0.kind === "shape" || c0.kind === "text") {
      const Cr = (k) => ({
        get: () => C().props.crop[k],
        set: (v, co) => edit((c) => (c.props.crop = { ...c.props.crop, [k]: v }), co),
      })
      const Pr = (k) => ({
        get: () => C().props[k],
        set: (v, co) => edit((c) => (c.props[k] = v), co),
      })
      const rows = []
      if (isMedia) {
        rows.push(
          h(
            "div",
            { class: "pair" },
            this.num("Left", { ...Cr("l"), min: 0, max: 90, scale: 100, unit: "%" }),
            this.num("Right", { ...Cr("r"), min: 0, max: 90, scale: 100, unit: "%" }),
          ),
          h(
            "div",
            { class: "pair" },
            this.num("Top", { ...Cr("t"), min: 0, max: 90, scale: 100, unit: "%" }),
            this.num("Bottom", { ...Cr("b"), min: 0, max: 90, scale: 100, unit: "%" }),
          ),
          this.num("Corner radius", { ...Pr("radius"), min: 0, max: 2000, unit: "px" }),
          this.toggle("Blurred background", Pr("bgBlur")),
        )
      }
      rows.push(
        this.num("Shadow", { ...Pr("shadow"), min: 0, max: 200, unit: "px", slider: true }),
        this.select("Blend", BLENDS, Pr("blend")),
      )
      out.push(this.section("crop", isMedia ? "Crop & style" : "Style", rows))
    }

    // ---- timing
    {
      const rows = [
        this.num("Start", {
          get: () => C().start,
          set: (v, co) => edit((c) => (c.start = Math.max(0, v)), co),
          min: 0,
          step: 0.01,
          unit: "s",
        }),
        this.num("Duration", {
          get: () => C().duration,
          set: (v, co) =>
            edit((c) => {
              let max = Infinity
              if (m && m.kind !== "image") max = (m.duration - c.in) / c.speed
              c.duration = clamp(v, 1 / fps(), max)
            }, co),
          min: 0.04,
          step: 0.01,
          unit: "s",
        }),
      ]
      if (c0.kind === "video" || c0.kind === "audio") {
        rows.push(
          this.num("Speed", {
            get: () => C().speed,
            set: (v, co) =>
              edit((c) => {
                const ns = clamp(v, 0.1, 8)
                // Keep the same source range: duration changes with speed.
                setSpeed(c, ns)
              }, co),
            min: 0.1,
            max: 8,
            step: 0.05,
            unit: "×",
          }),
          h(
            "div",
            { class: "row btn-row" },
            [0.25, 0.5, 1, 1.5, 2, 4].map((s) =>
              h(
                "button",
                {
                  class: "chip",
                  type: "button",
                  onclick: () =>
                    edit((c) => {
                      setSpeed(c, s)
                    }),
                },
                s + "×",
              ),
            ),
          ),
        )
      }
      out.push(this.section("timing", "Timing", rows))
    }

    // ---- audio
    if (hasSound) {
      const rows = [
        this.num("Volume", {
          get: () => propAt(C(), "volume", lt()),
          set: (v, co) => edit((c) => setProp(c, "volume", v, state.time - c.start, fps()), co),
          anim: "volume",
          min: 0,
          max: 400,
          scale: 100,
          unit: "%",
          slider: true,
        }),
        h(
          "div",
          { class: "pair" },
          this.num("Fade in", {
            get: () => C().fadeIn,
            set: (v, co) => edit((c) => (c.fadeIn = clamp(v, 0, c.duration)), co),
            min: 0,
            step: 0.1,
            unit: "s",
          }),
          this.num("Fade out", {
            get: () => C().fadeOut,
            set: (v, co) => edit((c) => (c.fadeOut = clamp(v, 0, c.duration)), co),
            min: 0,
            step: 0.1,
            unit: "s",
          }),
        ),
        this.toggle("Mute", { get: () => C().muted, set: (v) => edit((c) => (c.muted = v)) }),
      ]
      rows.push(
        h(
          "div",
          { class: "row btn-row" },
          c0.kind === "video" && !c0.muted
            ? h(
                "button",
                { class: "chip", type: "button", onclick: () => A.detachAudio(C()) },
                icon("unlink", 14),
                "Detach audio",
              )
            : null,
          h(
            "button",
            {
              class: "chip",
              type: "button",
              onclick: (e) => busy(e.currentTarget, () => A.removeSilence(C())),
            },
            icon("wand", 14),
            "Remove silences",
          ),
        ),
      )
      out.push(this.section("audio", "Audio", rows))
    }

    // ---- animation
    if (visual) {
      const tr = (side) => {
        const opts = TRANSITIONS.filter((t) => !t.textOnly || c0.kind === "text").map((t) => [
          t.id,
          t.label,
        ])
        return [
          this.select(side === "tin" ? "In" : "Out", opts, {
            get: () => C()[side].type,
            set: (v) => edit((c) => (c[side] = { ...c[side], type: v })),
          }),
          this.num(side === "tin" ? "In duration" : "Out duration", {
            get: () => C()[side].dur,
            set: (v, co) =>
              edit((c) => (c[side] = { ...c[side], dur: clamp(v, 0.05, c.duration) }), co),
            min: 0.05,
            max: 30,
            step: 0.05,
            unit: "s",
          }),
        ]
      }
      out.push(this.section("anim", "Animation", [...tr("tin"), ...tr("tout")]))
    }

    // ---- color
    if (visual && c0.kind !== "color") {
      const F = (k) => ({
        get: () => C().fx[k] ?? FX_DEFAULT[k],
        set: (v, co) => edit((c) => ((c.fx[k] = v), (c.preset = "custom")), co),
      })
      const grid = h("div", { class: "presets" })
      let tries = 0
      const buildPresets = () => {
        const cur = C()
        if (!cur) return
        if (
          (cur.kind === "video" || cur.kind === "image") &&
          !this.player.source(cur) &&
          tries++ < 20
        )
          return setTimeout(buildPresets, 250)
        const snap = this.player.snapshot(160)
        grid.replaceChildren(
          ...PRESETS.map((pr) => {
            const cv = h("canvas", { width: 120, height: Math.round((120 * S.height) / S.width) })
            const ctx = cv.getContext("2d")
            const fx = presetFx(pr.id)
            ctx.filter = cssFilter(fx, 0, 0.5)
            ctx.drawImage(snap.canvas, 0, 0, cv.width, cv.height)
            ctx.filter = "none"
            if (fx.temperature) {
              ctx.globalCompositeOperation = "soft-light"
              const a = Math.min(1, Math.abs(fx.temperature) / 100) * 0.7
              ctx.fillStyle = fx.temperature > 0 ? `rgba(255,140,30,${a})` : `rgba(30,120,255,${a})`
              ctx.fillRect(0, 0, cv.width, cv.height)
              ctx.globalCompositeOperation = "source-over"
            }
            if (fx.vignette) {
              const d = Math.hypot(cv.width, cv.height) / 2
              const g = ctx.createRadialGradient(
                cv.width / 2,
                cv.height / 2,
                d * 0.35,
                cv.width / 2,
                cv.height / 2,
                d,
              )
              g.addColorStop(0, "rgba(0,0,0,0)")
              g.addColorStop(1, `rgba(0,0,0,${fx.vignette / 100})`)
              ctx.fillStyle = g
              ctx.fillRect(0, 0, cv.width, cv.height)
            }
            const b = h(
              "button",
              {
                class: "preset" + (C().preset === pr.id ? " on" : ""),
                type: "button",
                onclick: () =>
                  edit((c) => {
                    c.fx = presetFx(pr.id)
                    c.preset = pr.id
                  }),
              },
              cv,
              h("span", {}, pr.label),
            )
            return b
          }),
        )
      }
      this.updaters.push((structural) => {
        if (!structural) return
        for (const [i, b] of [...grid.children].entries())
          b.classList.toggle("on", C().preset === PRESETS[i]?.id)
      })
      const presetSec = this.section("filters", "Filters", [
        grid,
        h(
          "div",
          { class: "row btn-row" },
          h(
            "button",
            { class: "chip", type: "button", onclick: () => buildPresets() },
            icon("camera", 14),
            "Refresh previews",
          ),
        ),
      ])
      out.push(presetSec)
      requestAnimationFrame(buildPresets)
      if (isMedia) {
        const K = (k) => ({
          get: () => C().fx[k] ?? FX_DEFAULT[k],
          set: (v, co) => edit((c) => (c.fx[k] = v), co),
        })
        out.push(
          this.section("key", "Green screen", [
            this.toggle("Remove color", K("key")),
            this.color("Key color", K("keyColor")),
            window.EyeDropper
              ? h(
                  "div",
                  { class: "row btn-row" },
                  h(
                    "button",
                    {
                      class: "chip",
                      type: "button",
                      onclick: async () => {
                        try {
                          const { sRGBHex } = await new window.EyeDropper().open()
                          edit((c) => ((c.fx.keyColor = sRGBHex), (c.fx.key = true)))
                        } catch {}
                      },
                    },
                    icon("wand", 14),
                    "Pick color from the preview",
                  ),
                )
              : null,
            this.num("Strength", { ...K("keySim"), min: 0, max: 100, unit: "%", slider: true }),
            this.num("Softness", { ...K("keySmooth"), min: 0, max: 100, unit: "%", slider: true }),
            this.num("Spill", { ...K("keySpill"), min: 0, max: 100, unit: "%", slider: true }),
          ]),
        )
      }
      out.push(
        this.section("adjust", "Adjust", [
          this.num("Brightness", { ...F("brightness"), min: 0, max: 200, unit: "%", slider: true }),
          this.num("Contrast", { ...F("contrast"), min: 0, max: 200, unit: "%", slider: true }),
          this.num("Saturation", { ...F("saturate"), min: 0, max: 300, unit: "%", slider: true }),
          this.num("Temperature", { ...F("temperature"), min: -100, max: 100, slider: true }),
          this.num("Hue", { ...F("hue"), min: -180, max: 180, unit: "°", slider: true }),
          this.num("Blur", { ...F("blur"), min: 0, max: 50, step: 0.5, slider: true }),
          this.num("Vignette", { ...F("vignette"), min: 0, max: 100, unit: "%", slider: true }),
          this.num("Black & white", {
            ...F("grayscale"),
            min: 0,
            max: 100,
            unit: "%",
            slider: true,
          }),
          this.num("Sepia", { ...F("sepia"), min: 0, max: 100, unit: "%", slider: true }),
          this.num("Invert", { ...F("invert"), min: 0, max: 100, unit: "%", slider: true }),
          h(
            "div",
            { class: "row btn-row" },
            h(
              "button",
              {
                class: "chip",
                type: "button",
                onclick: () => edit((c) => ((c.fx = { ...FX_DEFAULT }), (c.preset = "none"))),
              },
              "Reset adjustments",
            ),
          ),
        ]),
      )
    }
    for (const u of this.updaters) u(true)
    return h("div", { class: "insp" }, out)
  }

  // A media item picked in the media panel: preview it, mark in and out, add it.
  mediaInfo(m) {
    const fps = state.project.scene.fps
    let inP = 0
    let outP = m.kind === "image" ? 5 : m.duration
    const el =
      m.kind === "image"
        ? h("img", { src: mediaUrl(m), class: "mprev", alt: "" })
        : h(m.kind === "audio" ? "audio" : "video", {
            src: mediaUrl(m),
            class: "mprev" + (m.kind === "audio" ? " audio" : ""),
            controls: true,
            playsinline: true,
            preload: "auto",
          })
    const range = h("div", { class: "inout" })
    const mark = h("div", { class: "inout-range" })
    range.append(mark)
    const label = h("span", { class: "muted small" })
    const sync = () => {
      if (m.kind === "image") return
      mark.style.left = (inP / m.duration) * 100 + "%"
      mark.style.width = ((outP - inP) / m.duration) * 100 + "%"
      label.textContent = `${fmtTime(inP, fps)} → ${fmtTime(outP, fps)} · ${(outP - inP).toFixed(2)}s`
    }
    sync()
    const meta = [
      m.kind === "image" ? "Image" : m.kind === "audio" ? "Audio" : "Video",
      m.width ? `${m.width}×${m.height}` : null,
      m.duration && m.kind !== "image" ? fmtDur(m.duration) : null,
      m.size ? fmtBytes(m.size) : null,
    ]
      .filter(Boolean)
      .join(" · ")
    const kids = [
      h(
        "div",
        { class: "insp-head" },
        h(
          "div",
          { class: "insp-kind k-" + (m.kind === "image" ? "image" : m.kind) },
          icon(m.kind === "audio" ? "music" : m.kind === "image" ? "image" : "film", 16),
        ),
        h("div", { class: "insp-title ellipsis" }, m.name),
      ),
      h("div", { class: "insp-info" }, meta),
      h("div", { class: "mprev-wrap" }, el),
    ]
    if (m.kind !== "image") {
      kids.push(
        h(
          "div",
          { class: "inout-box" },
          range,
          h(
            "div",
            { class: "row between" },
            h(
              "button",
              {
                class: "chip",
                type: "button",
                title: "Mark in (I)",
                onclick: () => ((inP = Math.min(el.currentTime, outP - 0.1)), sync()),
              },
              "Set in",
            ),
            label,
            h(
              "button",
              {
                class: "chip",
                type: "button",
                title: "Mark out (O)",
                onclick: () => ((outP = Math.max(el.currentTime, inP + 0.1)), sync()),
              },
              "Set out",
            ),
          ),
        ),
      )
    }
    kids.push(
      h(
        "div",
        { class: "insp-actions" },
        h(
          "button",
          {
            class: "btn primary block",
            type: "button",
            onclick: () =>
              A.addMediaClip(m, {
                inPoint: m.kind === "image" ? 0 : inP,
                outPoint: m.kind === "image" ? null : outP,
              }),
          },
          icon("plus", 16),
          "Add at playhead",
        ),
      ),
    )
    return h("div", { class: "insp" }, kids)
  }

  jumpKey(c, dir) {
    const times = [
      ...new Set(
        Object.values(c.kf || {})
          .flat()
          .filter((k) => k.t >= -1e-6 && k.t <= c.duration + 1e-6)
          .map((k) => c.start + k.t),
      ),
    ].sort((a, b) => a - b)
    const eps = 1e-3
    const t =
      dir > 0
        ? times.find((x) => x > state.time + eps)
        : [...times].reverse().find((x) => x < state.time - eps)
    if (t != null) seek(t)
  }

  multiPanel() {
    const n = state.sel.size
    return h(
      "div",
      { class: "insp" },
      h(
        "div",
        { class: "insp-head" },
        h("div", { class: "insp-kind" }, icon("layers", 16)),
        h("div", { class: "insp-title" }, `${n} clips`),
      ),
      h(
        "div",
        { class: "insp-actions" },
        btn("Duplicate", () => A.duplicate()),
        btn("Copy", () => A.copy()),
        btn("Delete", () => A.remove(), "danger"),
      ),
    )
  }

  // --- project -----------------------------------------------------------------------

  projectPanel() {
    const P = state.project
    const edit = (fn, co) => commit((p) => fn(p), { coalesce: co })
    const sizeChips = h(
      "div",
      { class: "size-chips" },
      SIZES.map((s) =>
        h(
          "button",
          {
            class: "size-chip",
            type: "button",
            title: s.sub,
            onclick: () =>
              edit((p) => {
                resizeScene(p, s.w, s.h)
              }),
          },
          h("span", { class: "ratio-wrap" }, ratioBox(s.w, s.h, 22)),
          h("b", {}, s.label),
          h("small", {}, `${s.w}×${s.h}`),
        ),
      ),
    )
    this.updaters.push(() => {
      for (const [i, b] of [...sizeChips.children].entries())
        b.classList.toggle(
          "on",
          SIZES[i].w === state.project.scene.width && SIZES[i].h === state.project.scene.height,
        )
    })
    const info = h("div", { class: "insp-info" })
    this.updaters.push(() => {
      const p = state.project
      info.textContent = `${fmtDur(projectDuration(p))} · ${p.clips.length} clip${p.clips.length === 1 ? "" : "s"} · ${p.layers.length} layer${p.layers.length === 1 ? "" : "s"}`
    })
    return h(
      "div",
      { class: "insp" },
      h(
        "div",
        { class: "insp-head" },
        h("div", { class: "insp-kind" }, icon("settings", 16)),
        h("div", { class: "insp-title" }, "Project"),
      ),
      info,
      this.section("canvas", "Canvas", [
        sizeChips,
        h(
          "div",
          { class: "pair" },
          this.num("Width", {
            get: () => state.project.scene.width,
            set: (v) => edit((p) => resizeScene(p, Math.round(v / 2) * 2, p.scene.height)),
            min: 16,
            max: 7680,
            unit: "px",
          }),
          this.num("Height", {
            get: () => state.project.scene.height,
            set: (v) => edit((p) => resizeScene(p, p.scene.width, Math.round(v / 2) * 2)),
            min: 16,
            max: 7680,
            unit: "px",
          }),
        ),
        this.select(
          "Frame rate",
          [
            [24, "24 fps"],
            [25, "25 fps"],
            [30, "30 fps"],
            [50, "50 fps"],
            [60, "60 fps"],
          ],
          {
            get: () => state.project.scene.fps,
            set: (v) => edit((p) => (p.scene.fps = +v)),
          },
        ),
        this.color("Background", {
          get: () => state.project.scene.background,
          set: (v, co) => edit((p) => (p.scene.background = v), co),
        }),
      ]),
      this.section("project", "Tips", [
        h(
          "ul",
          { class: "tips" },
          h("li", {}, "Drop files anywhere to import them"),
          h("li", {}, "Drag media onto the timeline, or press + on it"),
          h(
            "li",
            {},
            "Space plays, ",
            h("kbd", {}, "S"),
            " or ",
            h("kbd", {}, "B"),
            " splits, ",
            h("kbd", {}, "?"),
            " shows every shortcut",
          ),
          h("li", {}, "Click the ◇ next to a property to animate it"),
        ),
      ]),
    )
    void P
  }
}

// Change a clip's speed, keeping its source range; keyframes stretch with it.
function setSpeed(c, ns) {
  const f = c.speed / ns
  c.duration = c.duration * f
  c.speed = ns
  for (const ks of Object.values(c.kf || {})) for (const k of ks) k.t *= f
}

// Change the canvas size, keeping clips at the same relative place.
export function resizeScene(p, w, hh) {
  p.sceneSet = true
  const sx = w / p.scene.width
  const sy = hh / p.scene.height
  if (sx === 1 && sy === 1) return
  for (const c of p.clips) {
    c.props.x *= sx
    c.props.y *= sy
    for (const k of c.kf?.x || []) k.v *= sx
    for (const k of c.kf?.y || []) k.v *= sy
  }
  p.scene.width = w
  p.scene.height = hh
}
