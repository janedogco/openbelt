export const THEME_DATA = "/*openbelt-person-theme*/null"

export const THEME_SCRIPT = `{
  const preference = ${THEME_DATA}
  const apply = (theme) => { document.documentElement.dataset.theme = theme }
  let revision = 0
  const save = async (theme, action) => {
    const current = ++revision
    const response = await fetch("/_theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme, action, form: preference.form }),
    })
    if (!response.ok) throw new Error("Couldn't save your theme. Try again.")
    const saved = await response.json()
    if (current === revision) apply(saved.theme)
    try { localStorage.removeItem("openbelt-theme") } catch {}
  }
  window.openbeltTheme = (theme) => {
    if (!preference) { apply(theme); return Promise.resolve() }
    return save(theme, "choose")
  }
  apply(preference?.theme ?? "system")
  if (preference) {
    if (preference.theme === null) {
      let legacy = null
      try { legacy = localStorage.getItem("openbelt-theme") } catch {}
      if (legacy === "light" || legacy === "dark") {
        apply(legacy)
        save(legacy, "import").catch(() => {})
      }
    } else {
      try { localStorage.removeItem("openbelt-theme") } catch {}
    }
  }
}`
