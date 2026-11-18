const dlg = document.querySelector("#prompt-dlg")

const copy = dlg.querySelector(".copy")

document.querySelector("#prompt-btn").onclick = () => dlg.showModal()

dlg.querySelector(".close").onclick = () => dlg.close()

dlg.addEventListener("click", (e) => {
  if (e.target === dlg) dlg.close()
})

copy.onclick = async () => {
  await navigator.clipboard.writeText(dlg.querySelector("pre").textContent)
  copy.textContent = "Copied"
  setTimeout(() => (copy.textContent = "Copy"), 1500)
}
