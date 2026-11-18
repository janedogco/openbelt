const root = document.documentElement

const btn = document.querySelector("#theme-btn")

const dark = () =>
  root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches

const label = () => btn.setAttribute("aria-label", dark() ? "Light theme" : "Dark theme")

btn.onclick = () => {
  const theme = dark() ? "light" : "dark"
  root.dataset.theme = theme

  try {
    localStorage.setItem("theme", theme)
  } catch {}

  label()
}

label()
